import { randomBytes, timingSafeEqual } from 'node:crypto'

import { tenantHeaders } from '@mekka/protocol'

const maxBodyBytes = 11 * 1024 * 1024
const csrfCookieName =
  process.env.NODE_ENV === 'production'
    ? '__Host-mekka-studio-storage-csrf'
    : 'mekka-studio-storage-csrf'
const allowedRequests = [
  { method: 'GET', pattern: /^buckets(?:\?.*)?$/ },
  { method: 'POST', pattern: /^buckets$/ },
  { method: 'GET', pattern: /^buckets\/[a-z0-9-]{3,63}$/ },
  { method: 'PATCH', pattern: /^buckets\/[a-z0-9-]{3,63}$/ },
  { method: 'DELETE', pattern: /^buckets\/[a-z0-9-]{3,63}$/ },
  { method: 'GET', pattern: /^buckets\/[a-z0-9-]{3,63}\/objects(?:\?.*)?$/ },
  { method: 'GET', pattern: /^buckets\/[a-z0-9-]{3,63}\/policy-summary$/ },
  { method: 'PUT', pattern: /^object\/[a-z0-9-]{3,63}\/.+$/ },
  { method: 'DELETE', pattern: /^object\/[a-z0-9-]{3,63}\/.+$/ },
  { method: 'POST', pattern: /^object\/sign\/[a-z0-9-]{3,63}\/.+$/ },
  { method: 'POST', pattern: /^resumable\/[a-z0-9-]{3,63}\/.+$/ },
  { method: 'HEAD', pattern: /^resumable\/[A-Za-z0-9_-]{3,128}$/ },
  { method: 'PATCH', pattern: /^resumable\/[A-Za-z0-9_-]{3,128}$/ },
  { method: 'DELETE', pattern: /^resumable\/[A-Za-z0-9_-]{3,128}$/ },
] as const
const forwardedHeaders = [
  'authorization',
  'content-type',
  'idempotency-key',
  'tus-resumable',
  'upload-length',
  'upload-metadata',
  'upload-offset',
  tenantHeaders.organizationId,
  tenantHeaders.projectId,
  tenantHeaders.environmentId,
  tenantHeaders.branchId,
  tenantHeaders.generation,
  tenantHeaders.correlationId,
] as const
const returnedHeaders = [
  'content-type',
  'location',
  'tus-resumable',
  'upload-offset',
  'upload-length',
  'upload-expires',
  'etag',
  'x-mekka-content-sha256',
  tenantHeaders.correlationId,
] as const

export async function handleStorageAdminWebRequest(
  request: Request,
  projectRef: string,
  splat: string | undefined
): Promise<Response> {
  if (!splat || !request.headers.get('authorization')) return errorResponse('auth', 401)
  if (request.headers.get(tenantHeaders.projectId) !== projectRef) {
    return errorResponse('forbidden', 403)
  }
  if (splat === 'csrf' && request.method === 'GET') return issueCsrf(request)

  const url = new URL(request.url)
  const pathWithQuery = `${splat}${url.search}`
  const isAllowed = allowedRequests.some(
    ({ method, pattern }) => method === request.method && pattern.test(pathWithQuery)
  )
  if (!isAllowed) return errorResponse('unsupported', 404)
  const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
  if (isMutation && !hasValidCsrf(request)) return errorResponse('forbidden', 403)

  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return errorResponse('infrastructure', 503)
  const headers = new Headers({ accept: 'application/json' })
  for (const name of forwardedHeaders) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  try {
    const body = isMutation ? await readBoundedBody(request) : undefined
    const response = await fetch(
      `${backendUrl.replace(/\/$/, '')}/storage/v1/${encodedUpstreamPath(url.pathname, projectRef)}${url.search}`,
      {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: toRequestBody(body) }),
        signal: request.signal,
      }
    )
    const responseHeaders = new Headers({ 'cache-control': 'no-store' })
    for (const name of returnedHeaders) {
      const value = response.headers.get(name)
      if (value) responseHeaders.set(name, value)
    }
    return new Response(response.body, { status: response.status, headers: responseHeaders })
  } catch {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    return errorResponse('infrastructure', 503)
  }
}

function toRequestBody(body: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(body.byteLength)
  copy.set(body)
  return copy.buffer
}

function issueCsrf(request: Request): Response {
  const existingToken = readCookie(request.headers.get('cookie'), csrfCookieName)
  const token =
    existingToken && /^[A-Za-z0-9_-]{43}$/.test(existingToken)
      ? existingToken
      : randomBytes(32).toString('base64url')
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return Response.json(
    { token },
    {
      headers: {
        'cache-control': 'no-store',
        'set-cookie': `${csrfCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=900`,
      },
    }
  )
}

function hasValidCsrf(request: Request): boolean {
  const header = request.headers.get('x-mekka-csrf-token')
  const cookie = readCookie(request.headers.get('cookie'), csrfCookieName)
  if (!header || !cookie) return false
  const left = Buffer.from(header)
  const right = Buffer.from(cookie)
  return left.length === right.length && timingSafeEqual(left, right)
}

function readCookie(value: string | null, name: string): string | undefined {
  if (!value) return undefined
  for (const part of value.split(';')) {
    const [cookieName, ...cookieValue] = part.trim().split('=')
    if (cookieName === name) return decodeURIComponent(cookieValue.join('='))
  }
  return undefined
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > maxBodyBytes) throw new Error('Body too large')
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel()
        throw new Error('Body too large')
      }
      chunks.push(Uint8Array.from(chunk.value))
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function encodedUpstreamPath(pathname: string, projectRef: string): string {
  const prefix = `/api/platform/storage-admin/${encodeURIComponent(projectRef)}/`
  if (!pathname.startsWith(prefix)) throw new Error('Invalid Storage proxy path')
  const path = pathname.slice(prefix.length)
  if (!path || path.includes('\\')) throw new Error('Invalid Storage proxy path')
  return path
}

function errorResponse(code: string, status: number): Response {
  return Response.json({ error: { code } }, { status, headers: { 'cache-control': 'no-store' } })
}
