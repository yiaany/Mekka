import assert from 'node:assert/strict'
import { afterAll, beforeAll, test, vi } from 'vitest'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/auth-admin/[ref]/[...path]'
import { Route as authAdminRoute } from '@/routes/api/platform/auth-admin/$ref/$'

vi.mock('@/lib/api/apiAuthenticate', () => ({
  apiAuthenticate: vi.fn(async (req: { headers: Record<string, unknown> }) =>
    typeof req.headers.authorization === 'string'
      ? { sub: 'studio-user-001' }
      : { error: new Error('missing access token') }
  ),
}))

const handleRequest = toWebHandler(nextHandler)
const originalEnvironment = {
  backendUrl: process.env.STUDIO_BACKEND_API_URL,
  internalToken: process.env.MEKKA_INTERNAL_PROXY_TOKEN,
  nodeEnv: process.env.NODE_ENV,
  publicOrigin: process.env.AUTH_PUBLIC_ORIGIN,
}
const originalFetch = globalThis.fetch
let upstream: Request | undefined

beforeAll(() => {
  process.env.STUDIO_BACKEND_API_URL = 'https://auth-admin.example.test'
  process.env.MEKKA_INTERNAL_PROXY_TOKEN = 'server-only-internal-token'
  process.env.AUTH_PUBLIC_ORIGIN = 'https://studio.example.test'
  Reflect.set(process.env, 'NODE_ENV', 'production')
  globalThis.fetch = async (input, init) => {
    upstream = new Request(input, init)
    return Response.json({ deleted: true, userId: 'user-001' })
  }
})

afterAll(() => {
  globalThis.fetch = originalFetch
  restoreEnvironment('STUDIO_BACKEND_API_URL', originalEnvironment.backendUrl)
  restoreEnvironment('MEKKA_INTERNAL_PROXY_TOKEN', originalEnvironment.internalToken)
  restoreEnvironment('AUTH_PUBLIC_ORIGIN', originalEnvironment.publicOrigin)
  restoreEnvironment('NODE_ENV', originalEnvironment.nodeEnv)
})

test('requires the existing Studio server authentication in production', async () => {
  const response = await handleRequest({
    request: new Request('https://studio.example.test/api/platform/auth-admin/local/users'),
    params: { ref: 'local', path: 'users' },
  })

  assert.equal(response.status, 401)
  assert.equal(upstream, undefined)
})

test('issues CSRF only after Studio authentication', async () => {
  const response = await handleRequest({
    request: new Request('https://studio.example.test/api/platform/auth-admin/local/csrf', {
      headers: { authorization: 'Bearer studio-session-token' },
    }),
    params: { ref: 'local', path: 'csrf' },
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie') ?? '', /__Host-mekka-studio-csrf=/)
  assert.equal(upstream, undefined)
})

test('relies on TanStack route handlers covering every Next auth-admin mutation method', () => {
  const handlers = authAdminRoute.options?.server?.handlers
  assert.ok(handlers)
  assert.equal(typeof handlers, 'object')
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) {
    assert.equal(
      typeof (handlers as Partial<Record<(typeof method), unknown>>)[method],
      'function',
      `${method} handler missing`
    )
  }
})

test('enforces CSRF and replaces a browser internal header with the server secret', async () => {
  const csrf = 'a'.repeat(43)
  const rejected = await handleRequest({
    request: new Request('https://studio.example.test/api/platform/auth-admin/local/users/user-001', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer studio-session-token',
        'content-type': 'application/json',
        'idempotency-key': 'auth-user-delete-0001',
      },
      body: JSON.stringify({ confirmation: 'user-001' }),
    }),
    params: { ref: 'local', path: 'users/user-001' },
  })
  assert.equal(rejected.status, 403)
  assert.equal(upstream, undefined)

  const response = await handleRequest({
    request: new Request('https://studio.example.test/api/platform/auth-admin/local/users/user-001', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer studio-session-token',
        cookie: `__Host-mekka-studio-csrf=${csrf}`,
        'content-type': 'application/json',
        'idempotency-key': 'auth-user-delete-0001',
        'x-mekka-csrf-token': csrf,
        'x-mekka-internal-proxy': 'browser-controlled-token',
      },
      body: JSON.stringify({ confirmation: 'user-001' }),
    }),
    params: { ref: 'local', path: 'users/user-001' },
  })

  assert.equal(response.status, 200)
  const captured = upstream as Request | undefined
  assert.ok(captured)
  assert.equal(captured.method, 'DELETE')
  assert.equal(captured.headers.get('x-mekka-internal-proxy'), 'server-only-internal-token')
  assert.equal(captured.headers.has('authorization'), false)
  assert.deepEqual(await captured.json(), { confirmation: 'user-001' })
})

test('forwards a mutation body verbatim when the client omits content-type', async () => {
  const csrf = 'b'.repeat(43)
  const response = await handleRequest({
    request: new Request('https://studio.example.test/api/platform/auth-admin/local/users/user-001', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer studio-session-token',
        cookie: `__Host-mekka-studio-csrf=${csrf}`,
        'idempotency-key': 'auth-user-delete-0002',
        'x-mekka-csrf-token': csrf,
      },
      body: JSON.stringify({ confirmation: 'user-001' }),
    }),
    params: { ref: 'local', path: 'users/user-001' },
  })

  assert.equal(response.status, 200)
  const captured = upstream as Request | undefined
  assert.ok(captured)
  assert.equal(captured.headers.get('content-type'), 'application/json')
  assert.equal(await captured.text(), JSON.stringify({ confirmation: 'user-001' }))
})

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) Reflect.deleteProperty(process.env, name)
  else Reflect.set(process.env, name, value)
}
