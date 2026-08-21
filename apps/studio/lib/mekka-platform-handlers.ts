type RouteRequest<TParams extends Record<string, string | undefined>> = Readonly<{
  request: Request
  params: TParams
}>

const hopByHopHeaders = [
  'connection',
  'content-length',
  'expect',
  'host',
  'transfer-encoding',
] as const

export async function handleProjectAuthProxy({
  request,
  params,
}: RouteRequest<{ _splat?: string }>): Promise<Response> {
  const backendUrl = resolveBackendUrl(request)
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })

  const path = normalizeSplat(params._splat)
  if (path === null) return Response.json({ error: 'not_found' }, { status: 404 })

  try {
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer()
    const headers = new Headers(request.headers)
    for (const name of hopByHopHeaders) headers.delete(name)

    return await fetch(
      `${backendUrl.replace(/\/$/, '')}/auth/${path}${new URL(request.url).search}`,
      {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      }
    )
  } catch (error) {
    console.error('Project Auth proxy failed', error)
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

export async function handleAgentTokenRequest({
  request,
  params,
}: RouteRequest<{ ref: string }>): Promise<Response> {
  if (params.ref !== 'local') return Response.json({ error: 'not_found' }, { status: 404 })
  const backendUrl = resolveBackendUrl(request)
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })
  const payload: unknown = await request.json().catch(() => ({}))
  if (!hasAccessToken(payload)) return Response.json({ error: 'validation' }, { status: 400 })

  try {
    const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
    return await fetch(`${backendUrl.replace(/\/$/, '')}/auth-local/agent-token`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${payload.accessToken}`,
        'content-type': 'application/json',
        ...(internalProxyToken ? { 'x-mekka-internal-proxy': internalProxyToken } : {}),
      },
      body: JSON.stringify({ mode: payload.mode ?? 'read', allowRowData: payload.allowRowData === true }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

export async function handleVerificationCodeRequest({
  request,
  params,
}: RouteRequest<{ ref: string }>): Promise<Response> {
  if (process.env.MEKKA_LOCAL_DEV !== '1' || params.ref !== 'local') {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  const backendUrl = resolveBackendUrl(request)
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })
  const email = new URL(request.url).searchParams.get('email') ?? ''
  try {
    return await fetch(
      `${backendUrl.replace(/\/$/, '')}/auth-local/verification-code?email=${encodeURIComponent(email)}`,
      { signal: AbortSignal.timeout(5_000) }
    )
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

export async function handleApprovalListRequest({
  request,
}: RouteRequest<Record<string, never>>): Promise<Response> {
  const backendUrl = resolveBackendUrl(request)
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
  if (!backendUrl || !internalProxyToken) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  const authorization = readApplicationAuthorization(request)
  if (authorization === null) return Response.json({ error: 'auth' }, { status: 401 })
  try {
    return await fetch(`${backendUrl.replace(/\/$/, '')}/mcp-admin/approvals`, {
      headers: {
        authorization,
        'x-mekka-internal-proxy': internalProxyToken,
      },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

export async function handleApprovalDecisionRequest({
  request,
  params,
}: RouteRequest<{ approvalId: string }>): Promise<Response> {
  const backendUrl = resolveBackendUrl(request)
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
  if (!backendUrl || !internalProxyToken) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  const authorization = readApplicationAuthorization(request)
  if (authorization === null) return Response.json({ error: 'auth' }, { status: 401 })
  const body = await request.text()
  if (body.length === 0 || body.length > 1_024) {
    return Response.json({ error: 'validation' }, { status: 400 })
  }
  try {
    return await fetch(
      `${backendUrl.replace(/\/$/, '')}/mcp-admin/approvals/${encodeURIComponent(params.approvalId)}`,
      {
        method: 'PATCH',
        headers: {
          authorization,
          'content-type': 'application/json',
          'x-mekka-internal-proxy': internalProxyToken,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      }
    )
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}

function normalizeSplat(value: string | undefined): string | null {
  if (!value) return null
  const segments = value.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null
  }
  return segments.map(encodeURIComponent).join('/')
}

function hasAccessToken(
  payload: unknown
): payload is { accessToken: string; mode?: 'read' | 'write'; allowRowData?: boolean } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'accessToken' in payload &&
    typeof payload.accessToken === 'string' &&
    payload.accessToken.length > 0 &&
    (!('mode' in payload) || payload.mode === 'read' || payload.mode === 'write') &&
    (!('allowRowData' in payload) || typeof payload.allowRowData === 'boolean')
  )
}

function readApplicationAuthorization(request: Request): string | null {
  const authorization = request.headers.get('x-mekka-application-authorization')
  return authorization !== null && /^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    ? authorization
    : null
}

function resolveBackendUrl(request: Request): string | null {
  const value = process.env.STUDIO_BACKEND_API_URL?.trim()
  if (!value) return null

  let backend: URL
  let requestUrl: URL
  try {
    backend = new URL(value)
    requestUrl = new URL(request.url)
  } catch {
    return null
  }

  if (
    !['http:', 'https:'].includes(backend.protocol) ||
    backend.username !== '' ||
    backend.password !== '' ||
    backend.search !== '' ||
    backend.hash !== '' ||
    requestOrigins(request, requestUrl).some((origin) => sameOrigin(backend, origin))
  ) {
    return null
  }

  return backend.toString().replace(/\/$/, '')
}

function requestOrigins(request: Request, requestUrl: URL): readonly URL[] {
  const origins = [requestUrl]
  const host = request.headers.get('host')
  if (host !== null) {
    const origin = parseRequestOrigin(requestUrl.protocol, host)
    if (origin !== null) origins.push(origin)
  }
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (forwardedHost) {
    const forwardedProtocol =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || requestUrl.protocol
    const origin = parseRequestOrigin(forwardedProtocol, forwardedHost)
    if (origin !== null) origins.push(origin)
  }
  return origins
}

function parseRequestOrigin(protocol: string, host: string): URL | null {
  if (!['http:', 'https:', 'http', 'https'].includes(protocol)) return null
  try {
    const origin = new URL(`${protocol.replace(/:$/, '')}://${host}`)
    return origin.pathname === '/' && origin.search === '' && origin.hash === '' ? origin : null
  } catch {
    return null
  }
}

function sameOrigin(left: URL, right: URL): boolean {
  return (
    normalizeHostname(left.hostname) === normalizeHostname(right.hostname) &&
    (right.port === '' || effectivePort(left) === effectivePort(right))
  )
}

function normalizeHostname(value: string): string {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '')
  return ['localhost', '127.0.0.1', '::1'].includes(hostname) ? 'loopback' : hostname
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80')
}
