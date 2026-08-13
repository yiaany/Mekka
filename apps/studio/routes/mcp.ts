import { createFileRoute } from '@tanstack/react-router'

const maxRequestBytes = 1_000_000
const maxResponseBytes = 2_000_000
const maxConcurrentRequests = 32
const rateWindowMs = 60_000
const maxRequestsPerWindow = 120
let activeRequests = 0
let rateWindowStartedAt = Date.now()
let requestsInWindow = 0

export const Route = createFileRoute('/mcp')({
  server: { handlers: { GET: proxyMcp, POST: proxyMcp, DELETE: proxyMcp } },
})

async function proxyMcp({ request }: { request: Request }): Promise<Response> {
  return proxyMcpRequest(request, '/mcp')
}

export async function proxyMcpRequest(request: Request, path: string): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })

  if (path === '/mcp' && !/^Bearer [A-Za-z0-9._~-]+$/.test(request.headers.get('authorization') ?? '')) {
    const metadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', request.url)
    return Response.json(
      { error: 'auth' },
      {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl.href}"` },
      }
    )
  }
  if (!takeRateSlot(Date.now())) {
    return Response.json({ error: 'rate_limit' }, { status: 429, headers: { 'retry-after': '60' } })
  }
  if (activeRequests >= maxConcurrentRequests) {
    return Response.json({ error: 'busy' }, { status: 503, headers: { 'retry-after': '1' } })
  }

  activeRequests += 1
  let released = false
  let streaming = false
  const releaseRequest = () => {
    if (released) return
    released = true
    activeRequests -= 1
  }
  const upstreamAbort = new AbortController()
  const abortUpstream = () => upstreamAbort.abort(request.signal.reason)
  request.signal.addEventListener('abort', abortUpstream, { once: true })
  const headersTimeout = setTimeout(() => upstreamAbort.abort(), 15_000)
  try {
    const headers = forwardedMcpHeaders(request.headers)
    const body = request.method === 'GET' ? undefined : await readBoundedBody(request, maxRequestBytes)
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: upstreamAbort.signal,
    })
    clearTimeout(headersTimeout)
    if (response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      streaming = true
      return new Response(
        proxyStreamingBody(response.body, {
          abort: () => upstreamAbort.abort(),
          cleanup: () => {
            request.signal.removeEventListener('abort', abortUpstream)
            releaseRequest()
          },
        }),
        {
          status: response.status,
          statusText: response.statusText,
          headers: forwardedMcpResponseHeaders(response.headers),
        }
      )
    }
    const responseBody = await readBoundedStream(response.body, maxResponseBytes)
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: forwardedMcpResponseHeaders(response.headers),
    })
  } catch (error) {
    if (error instanceof McpPayloadTooLargeError) {
      return Response.json({ error: 'payload_too_large' }, { status: 413 })
    }
    console.error('MCP proxy failed', error)
    return Response.json({ error: 'unavailable' }, { status: 503 })
  } finally {
    clearTimeout(headersTimeout)
    if (!streaming) {
      request.signal.removeEventListener('abort', abortUpstream)
      releaseRequest()
    }
  }
}

function proxyStreamingBody(
  upstream: ReadableStream<Uint8Array> | null,
  { abort, cleanup }: { abort: () => void; cleanup: () => void }
): ReadableStream<Uint8Array> | null {
  if (upstream === null) {
    cleanup()
    return null
  }
  const reader = upstream.getReader()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          reader.releaseLock()
          cleanup()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        reader.releaseLock()
        cleanup()
        controller.error(error)
      }
    },
    async cancel(reason) {
      abort()
      try {
        await reader.cancel(reason)
      } finally {
        reader.releaseLock()
        cleanup()
      }
    },
  })
}

function takeRateSlot(now: number): boolean {
  if (now - rateWindowStartedAt >= rateWindowMs) {
    rateWindowStartedAt = now
    requestsInWindow = 0
  }
  if (requestsInWindow >= maxRequestsPerWindow) return false
  requestsInWindow += 1
  return true
}

function forwardedMcpHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of [
    'accept',
    'accept-language',
    'authorization',
    'content-type',
    'last-event-id',
    'mcp-protocol-version',
    'mcp-session-id',
    'user-agent',
  ]) {
    const value = source.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function forwardedMcpResponseHeaders(source: Headers): Headers {
  const headers = new Headers()
  for (const name of ['cache-control', 'content-type', 'mcp-session-id', 'www-authenticate']) {
    const value = source.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

async function readBoundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new McpPayloadTooLargeError()
  return readBoundedStream(request.body, limit)
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<ArrayBuffer> {
  if (stream === null) return new ArrayBuffer(0)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new McpPayloadTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result.buffer
}

class McpPayloadTooLargeError extends Error {}
