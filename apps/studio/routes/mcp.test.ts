import { afterEach, describe, expect, it, vi } from 'vitest'

import { proxyMcpRequest } from './mcp'

describe('MCP public proxy', () => {
  afterEach(() => {
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
})
