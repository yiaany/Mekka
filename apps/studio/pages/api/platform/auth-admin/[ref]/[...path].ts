import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextApiRequest, NextApiResponse } from 'next'

import { tenantHeaders } from '@mekka/protocol'

const csrfCookieName = '__Host-mekka-studio-csrf'
const readPaths = [/^users$/, /^users\/[A-Za-z0-9_-]{3,128}$/, /^settings$/]
const mutationPaths = [
  /^users\/[A-Za-z0-9_-]{3,128}\/revoke$/,
  /^providers\/(?:google|github)$/,
  /^redirects$/,
  /^templates\/(?:email-verification|password-reset)$/,
]
const forwardedHeaders = [
  'authorization',
  tenantHeaders.organizationId,
  tenantHeaders.projectId,
  tenantHeaders.environmentId,
  tenantHeaders.branchId,
  tenantHeaders.generation,
  tenantHeaders.correlationId,
] as const

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path
  const projectRef = Array.isArray(req.query.ref) ? req.query.ref[0] : req.query.ref
  if (!path || !projectRef || typeof req.headers.authorization !== 'string') {
    return res.status(401).json({ error: { code: 'auth' } })
  }
  if (req.headers[tenantHeaders.projectId] !== projectRef) {
    return res.status(403).json({ error: { code: 'forbidden' } })
  }
  if (path === 'csrf' && req.method === 'GET') {
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

  const isRead = req.method === 'GET' && readPaths.some((pattern) => pattern.test(path))
  const isMutation =
    ['POST', 'PUT'].includes(req.method ?? '') && mutationPaths.some((pattern) => pattern.test(path))
  if (!isRead && !isMutation) return res.status(404).json({ error: { code: 'unsupported' } })
  if (isMutation && !hasValidCsrf(req)) {
    return res.status(403).json({ error: { code: 'forbidden' } })
  }
  if (isMutation && typeof req.headers['idempotency-key'] !== 'string') {
    return res.status(400).json({ error: { code: 'validation' } })
  }

  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return res.status(503).json({ error: { code: 'infrastructure' } })
  const headers = new Headers({ accept: 'application/json' })
  for (const name of forwardedHeaders) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  if (typeof req.headers.origin === 'string') headers.set('origin', req.headers.origin)
  if (typeof req.headers['x-mekka-csrf-token'] === 'string') {
    headers.set('x-mekka-csrf-token', req.headers['x-mekka-csrf-token'])
  }
  if (typeof req.headers['idempotency-key'] === 'string') {
    headers.set('idempotency-key', req.headers['idempotency-key'])
  }
  if (isMutation) headers.set('content-type', 'application/json')

  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  try {
    const response = await fetch(
      `${backendUrl.replace(/\/$/, '')}/auth-admin/${encodeURIComponent(projectRef)}/${path}${query}`,
      {
        method: req.method,
        headers,
        ...(isMutation ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal,
      }
    )
    const body = await response.arrayBuffer()
    const contentType = response.headers.get('content-type')
    const correlationId = response.headers.get(tenantHeaders.correlationId)
    if (contentType) res.setHeader('content-type', contentType)
    if (correlationId) res.setHeader(tenantHeaders.correlationId, correlationId)
    res.setHeader('cache-control', 'no-store')
    return res.status(response.status).send(Buffer.from(body))
  } catch {
    if (controller.signal.aborted) return
    return res.status(503).json({ error: { code: 'infrastructure' } })
  }
}

function hasValidCsrf(req: NextApiRequest): boolean {
  const header = req.headers['x-mekka-csrf-token']
  const cookie = req.cookies[csrfCookieName]
  if (typeof header !== 'string' || typeof cookie !== 'string') return false
  const left = Buffer.from(header)
  const right = Buffer.from(cookie)
  return left.length === right.length && timingSafeEqual(left, right)
}
