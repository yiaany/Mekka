import { afterEach, describe, expect, it, vi } from 'vitest'

import { proxyMcpRequest } from './mcp'

describe('MCP public proxy', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('rejects missing bearer authorization before contacting the backend', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://backend.test')
    const backend = vi.fn()
    vi.stubGlobal('fetch', backend)

    const response = await proxyMcpRequest(new Request('http://studio.test/mcp'), '/mcp')

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://studio.test/.well-known/oauth-protected-resource/mcp"'
    )
    expect(backend).not.toHaveBeenCalled()
  })

  it('rejects oversized request and response bodies', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://backend.test')
    const authorization = { authorization: `Bearer ${'a'.repeat(32)}` }
    const oversizedRequest = new Request('http://studio.test/mcp', {
      method: 'POST',
      headers: { ...authorization, 'content-length': '1000001' },
      body: 'x',
    })
    const requestResponse = await proxyMcpRequest(oversizedRequest, '/mcp')
    expect(requestResponse.status).toBe(413)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(2_000_001)))
    )
    const responseResponse = await proxyMcpRequest(
      new Request('http://studio.test/mcp', { method: 'POST', headers: authorization, body: '{}' }),
      '/mcp'
    )
    expect(responseResponse.status).toBe(413)
  })

  it('streams SSE beyond 15 seconds and cancels the upstream when the client disconnects', async () => {
    vi.useFakeTimers()
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://backend.test')
    const encoder = new TextEncoder()
    let streamController: ReadableStreamDefaultController<Uint8Array>
    let upstreamCancelled = false
    let upstreamSignal: AbortSignal | undefined
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode('data: first\n\n'))
      },
      cancel() {
        upstreamCancelled = true
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        upstreamSignal = init.signal as AbortSignal
        return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } })
      })
    )

    const response = await proxyMcpRequest(
      new Request('http://studio.test/mcp', {
        headers: { authorization: 'Bearer valid-token', accept: 'text/event-stream' },
      }),
      '/mcp'
    )
    const reader = response.body?.getReader()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('data: first\n\n')

    await vi.advanceTimersByTimeAsync(16_000)
    expect(upstreamSignal?.aborted).toBe(false)
    streamController!.enqueue(encoder.encode('data: second\n\n'))
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('data: second\n\n')

    await reader?.cancel('client disconnected')
    expect(upstreamSignal?.aborted).toBe(true)
    expect(upstreamCancelled).toBe(true)
  })
})
