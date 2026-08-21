import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleAgentTokenRequest } from './mekka-platform-handlers'

describe('handleAgentTokenRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('forwards explicit row-data opt-in to the local backend', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://127.0.0.1:3001')
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rowDataEnabled: true })))
    vi.stubGlobal('fetch', fetch)

    const response = await handleAgentTokenRequest({
      request: new Request('http://127.0.0.1:8082/api/platform/project-auth/local/agent-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: 'application-token', mode: 'read', allowRowData: true }),
      }),
      params: { ref: 'local' },
    })

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/auth-local/agent-token',
      expect.objectContaining({
        body: JSON.stringify({ mode: 'read', allowRowData: true }),
      })
    )
  })

  it('rejects malformed row-data permission values before proxying', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://127.0.0.1:3001')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const response = await handleAgentTokenRequest({
      request: new Request('http://127.0.0.1:8082/api/platform/project-auth/local/agent-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: 'application-token', allowRowData: 'yes' }),
      }),
      params: { ref: 'local' },
    })

    expect(response.status).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
})
