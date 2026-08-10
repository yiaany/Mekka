import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import nextAuthHandler from '@/pages/api/auth/[...path]'
import nextApprovalHandler from '@/pages/api/platform/mcp/approvals/[approvalId]'
import nextApprovalListHandler from '@/pages/api/platform/mcp/approvals'
import nextAgentTokenHandler from '@/pages/api/platform/project-auth/[ref]/agent-token'
import nextVerificationCodeHandler from '@/pages/api/platform/project-auth/[ref]/verification-code'
import { handleRequest as tanstackAuthHandler } from '@/routes/auth/$'
import { handleRequest as tanstackApprovalHandler } from '@/routes/api/platform/mcp/approvals/$approvalId'
import { handleRequest as tanstackApprovalListHandler } from '@/routes/api/platform/mcp/approvals'
import { handleRequest as tanstackAgentTokenHandler } from '@/routes/api/platform/project-auth/$ref/agent-token'
import { handleRequest as tanstackVerificationCodeHandler } from '@/routes/api/platform/project-auth/$ref/verification-code'
import nextConfig from '../../next.config'

const backendUrl = 'https://backend.example.test'

describe('Mekka framework server-route parity', () => {
  beforeEach(() => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', backendUrl)
    vi.stubEnv('MEKKA_INTERNAL_PROXY_TOKEN', 'internal-proxy-token')
    vi.stubEnv('MEKKA_LOCAL_DEV', '1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('rewrites every nested Next auth path to the raw API catch-all', async () => {
    await expect(nextConfig.rewrites?.()).resolves.toContainEqual({
      source: '/auth/:path*',
      destination: '/api/auth/:path*',
    })
  })

  it('rejects a shared backend URL that points back to Studio', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'http://127.0.0.1:8082')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await tanstackAuthHandler({
      request: new Request(
        'http://localhost:8082/auth/org-local/local/env-local/branch-main/1/sign-up/email',
        { method: 'POST', body: '{}' }
      ),
      params: { _splat: 'org-local/local/env-local/branch-main/1/sign-up/email' },
    })

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not let a spoofed forwarded host hide a Next shared-backend self-loop', async () => {
    vi.stubEnv('STUDIO_BACKEND_API_URL', 'https://studio.local')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await invokeNext(nextAuthHandler, {
      method: 'POST',
      url: '/api/auth/org-local/local/env-local/branch-main/1/sign-up/email',
      query: { path: ['org-local', 'local', 'env-local', 'branch-main', '1', 'sign-up', 'email'] },
      headers: {
        host: 'studio.local',
        'x-forwarded-host': 'attacker.example.test',
        'x-forwarded-proto': 'http',
      },
      body: '{}' as never,
    })

    expect(response.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['tanstack', 'next'])('%s proxies nested auth routes with raw bodies, headers, cookies, and query strings', async (framework) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe(`${backendUrl}/auth/org-local/local/env-local/branch-main/1/sign-up/email?invite=a%2Fb`)
      expect(request.method).toBe('POST')
      expect(request.headers.get('cookie')).toBe('project_session=session-value')
      expect(request.headers.get('x-request-id')).toBe('registration-1')
      expect(request.headers.has('host')).toBe(false)
      expect(await request.text()).toBe('{"email":"member@example.com"}')
      const headers = new Headers({ location: '/auth/continue' })
      headers.append('set-cookie', 'access=one; Path=/; HttpOnly')
      headers.append('set-cookie', 'refresh=two; Path=/; HttpOnly')
      return new Response(null, { status: 302, headers })
    })
    vi.stubGlobal('fetch', fetchMock)

    if (framework === 'tanstack') {
      const response = await tanstackAuthHandler({
        request: new Request(
          'http://studio.local/auth/org-local/local/env-local/branch-main/1/sign-up/email?invite=a%2Fb',
          {
            method: 'POST',
            headers: {
              cookie: 'project_session=session-value',
              'content-type': 'application/json',
              'x-request-id': 'registration-1',
            },
            body: '{"email":"member@example.com"}',
          }
        ),
        params: { _splat: 'org-local/local/env-local/branch-main/1/sign-up/email' },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe('/auth/continue')
      expect(response.headers.get('set-cookie')).toContain('access=one')
      expect(response.headers.get('set-cookie')).toContain('refresh=two')
    } else {
      const { req, res } = createMocks({
        method: 'POST',
        url: '/api/auth/org-local/local/env-local/branch-main/1/sign-up/email?invite=a%2Fb',
        query: { path: ['org-local', 'local', 'env-local', 'branch-main', '1', 'sign-up', 'email'] },
        headers: {
          host: 'studio.local',
          cookie: 'project_session=session-value',
          'content-type': 'application/json',
          'x-request-id': 'registration-1',
        },
        body: '{"email":"member@example.com"}' as never,
      })
      await nextAuthHandler(req, res)
      expect(res._getStatusCode()).toBe(302)
      expect(res.getHeader('location')).toBe('/auth/continue')
      expect(res.getHeader('set-cookie')).toEqual([
        'access=one; Path=/; HttpOnly',
        'refresh=two; Path=/; HttpOnly',
      ])
    }
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each(['tanstack', 'next'])('%s issues a read-write agent token without changing authorization semantics', async (framework) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.url).toBe(`${backendUrl}/auth-local/agent-token`)
      expect(request.headers.get('authorization')).toBe('Bearer application-access-token')
      expect(request.headers.get('x-mekka-internal-proxy')).toBe('internal-proxy-token')
      expect(await request.json()).toEqual({ mode: 'write' })
      return Response.json({ token: 'agent-token', expiresAt: 42, mode: 'write' })
    }))
    const body = JSON.stringify({ accessToken: 'application-access-token', mode: 'write' })

    const response = framework === 'tanstack'
      ? await tanstackAgentTokenHandler({
          request: new Request('http://studio.local/api/platform/project-auth/local/agent-token', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body,
          }),
          params: { ref: 'local' },
        })
      : await invokeNext(nextAgentTokenHandler, {
          method: 'POST',
          url: '/api/platform/project-auth/local/agent-token',
          query: { ref: 'local' },
          headers: { host: 'studio.local', 'content-type': 'application/json' },
          body: body as never,
        })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ token: 'agent-token', expiresAt: 42, mode: 'write' })
  })

  it.each(['tanstack', 'next'])('%s retrieves local verification codes', async (framework) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${backendUrl}/auth-local/verification-code?email=member%2Btest%40example.com`)
      return Response.json({ code: '123456' })
    }))
    const requestUrl = '/api/platform/project-auth/local/verification-code?email=member%2Btest%40example.com'
    const response = framework === 'tanstack'
      ? await tanstackVerificationCodeHandler({
          request: new Request(`http://studio.local${requestUrl}`),
          params: { ref: 'local' },
        })
      : await invokeNext(nextVerificationCodeHandler, {
          method: 'GET', url: requestUrl, query: { ref: 'local', email: 'member+test@example.com' },
          headers: { host: 'studio.local' },
        })
    expect(await response.json()).toEqual({ code: '123456' })
  })

  it.each(['tanstack', 'next'])('%s lists approvals and forwards an exact-SQL decision body to an encoded id', async (framework) => {
    const decision = '{"state":"approved","sql":"alter table tasks add column done integer"}'
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      expect(request.headers.get('x-mekka-internal-proxy')).toBe('internal-proxy-token')
      expect(request.headers.get('authorization')).toBe('Bearer application-access-token')
      if (request.method === 'GET') {
        expect(request.url).toBe(`${backendUrl}/mcp-admin/approvals`)
        return Response.json({ approvals: [{ approvalId: 'approval/one', sql: 'alter table tasks' }] })
      }
      expect(request.url).toBe(`${backendUrl}/mcp-admin/approvals/approval%2Fone`)
      expect(await request.text()).toBe(decision)
      return Response.json({ executionToken: 'one-time-token' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const listResponse = framework === 'tanstack'
      ? await tanstackApprovalListHandler({
          request: new Request('http://studio.local/api/platform/mcp/approvals', {
            headers: {
              'x-mekka-application-authorization': 'Bearer application-access-token',
            },
          }),
          params: {},
        })
      : await invokeNext(nextApprovalListHandler, {
          method: 'GET', url: '/api/platform/mcp/approvals',
          headers: {
            host: 'studio.local',
            'x-mekka-application-authorization': 'Bearer application-access-token',
          },
        })
    expect(listResponse.status).toBe(200)

    const decisionResponse = framework === 'tanstack'
      ? await tanstackApprovalHandler({
          request: new Request('http://studio.local/api/platform/mcp/approvals/approval%2Fone', {
            method: 'PATCH',
            headers: {
              'x-mekka-application-authorization': 'Bearer application-access-token',
              'content-type': 'application/json',
            },
            body: decision,
          }),
          params: { approvalId: 'approval/one' },
        })
      : await invokeNext(nextApprovalHandler, {
          method: 'PATCH', url: '/api/platform/mcp/approvals/approval%2Fone',
          query: { approvalId: 'approval/one' },
          headers: {
            host: 'studio.local',
            'x-mekka-application-authorization': 'Bearer application-access-token',
            'content-type': 'application/json',
          },
          body: decision as never,
        })
    expect(await decisionResponse.json()).toEqual({ executionToken: 'one-time-token' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['tanstack', 'next'])('%s rejects approval access without an application bearer token', async (framework) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = framework === 'tanstack'
      ? await tanstackApprovalListHandler({
          request: new Request('http://studio.local/api/platform/mcp/approvals'),
          params: {},
        })
      : await invokeNext(nextApprovalListHandler, {
          method: 'GET', url: '/api/platform/mcp/approvals', headers: { host: 'studio.local' },
        })

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

async function invokeNext(
  handler: (request: never, response: never) => unknown,
  options: Parameters<typeof createMocks>[0]
): Promise<Response> {
  const { req, res } = createMocks(options)
  await handler(req as never, res as never)
  const headers = new Headers()
  for (const [name, value] of Object.entries(res._getHeaders())) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, String(item)))
    else if (value !== undefined) headers.set(name, String(value))
  }
  return new Response(res._getData() || null, { status: res._getStatusCode(), headers })
}
