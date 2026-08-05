import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextApiRequest, NextApiResponse } from 'next'

import { tenantHeaders } from '@mekka/protocol'

export const config = { api: { bodyParser: false } }

const csrfCookieName =
  process.env.NODE_ENV === 'production'
    ? '__Host-mekka-studio-storage-csrf'
    : 'mekka-studio-storage-csrf'
const maxBodyBytes = 11 * 1024 * 1024
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const rawPath = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path
  const projectRef = Array.isArray(req.query.ref) ? req.query.ref[0] : req.query.ref
  if (!rawPath || !projectRef || typeof req.headers.authorization !== 'string') {
    return res.status(401).json({ error: { code: 'auth' } })
  }
  if (req.headers[tenantHeaders.projectId] !== projectRef) {
    return res.status(403).json({ error: { code: 'forbidden' } })
  }
  if (rawPath === 'csrf' && req.method === 'GET') return issueCsrf(req, res)
  const requestUrl = new URL(req.url ?? '/', 'http://studio.local')
  const query = requestUrl.search
  const path = `${rawPath}${query}`
  const isAllowed = allowedRequests.some(
    ({ method, pattern }) => method === req.method && pattern.test(path)
  )
  if (!isAllowed) return res.status(404).json({ error: { code: 'unsupported' } })
  const isMutation = !['GET', 'HEAD'].includes(req.method ?? '')
  if (isMutation && !hasValidCsrf(req)) {
    return res.status(403).json({ error: { code: 'forbidden' } })
  }

  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return res.status(503).json({ error: { code: 'infrastructure' } })
  const headers = new Headers({ accept: 'application/json' })
  for (const name of forwardedHeaders) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  try {
    const body = isMutation ? Uint8Array.from(await readBoundedBody(req)) : undefined
    const response = await fetch(
      `${backendUrl.replace(/\/$/, '')}/storage/v1/${encodedUpstreamPath(requestUrl.pathname, projectRef)}${query}`,
      {
        method: req.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      }
    )
    for (const name of returnedHeaders) {
      const value = response.headers.get(name)
      if (value) res.setHeader(name, value)
    }
    res.setHeader('cache-control', 'no-store')
    const responseBody = Buffer.from(await response.arrayBuffer())
    return res.status(response.status).send(responseBody)
  } catch {
    if (controller.signal.aborted) return
    return res.status(503).json({ error: { code: 'infrastructure' } })
  }
}

function encodedUpstreamPath(pathname: string, projectRef: string): string {
  const prefix = `/api/platform/storage-admin/${encodeURIComponent(projectRef)}/`
  if (!pathname.startsWith(prefix)) throw new Error('Invalid Storage proxy path')
  const path = pathname.slice(prefix.length)
  if (!path || path.includes('\\')) throw new Error('Invalid Storage proxy path')
  return path
}

function issueCsrf(req: NextApiRequest, res: NextApiResponse) {
  const existingToken = req.cookies[csrfCookieName]
  const token =
    typeof existingToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(existingToken)
      ? existingToken
      : randomBytes(32).toString('base64url')
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader(
    'set-cookie',
    `${csrfCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=900`
  )
  res.setHeader('cache-control', 'no-store')
  return res.status(200).json({ token })
}

function hasValidCsrf(req: NextApiRequest): boolean {
  const header = req.headers['x-mekka-csrf-token']
  const cookie = req.cookies[csrfCookieName]
  if (typeof header !== 'string' || typeof cookie !== 'string') return false
  const left = Buffer.from(header)
  const right = Buffer.from(cookie)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBoundedBody(req: NextApiRequest): Promise<Buffer> {
  const asyncRequest = req as NextApiRequest & {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>
  }
  if (typeof asyncRequest[Symbol.asyncIterator] !== 'function') {
    if (req.body === undefined || req.body === null) return Buffer.alloc(0)
    const buffered =
      typeof req.body === 'string'
        ? Buffer.from(req.body)
        : Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(JSON.stringify(req.body))
    if (buffered.byteLength > maxBodyBytes) throw new Error('Request body is too large')
    return buffered
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of asyncRequest as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : undefined
    if (!buffer) throw new Error('Invalid request body chunk')
    total += buffer.byteLength
    if (total > maxBodyBytes) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}
