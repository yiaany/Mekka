import type { NextApiRequest, NextApiResponse } from 'next'

import { tenantHeaders } from '@mekka/protocol'

const readPaths = new Set(['tables', 'schema/health'])
const readPathPatterns = [/^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/]
const mutationPaths = [
  /^tables$/,
  /^tables\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^columns$/,
  /^columns\/[A-Za-z_][A-Za-z0-9_]{0,63}\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^sql$/,
]
const forwardedHeaders = [
  'authorization',
  'x-mekka-publishable-key',
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
  const isReadPath = path !== undefined && (readPaths.has(path) || readPathPatterns.some((pattern) => pattern.test(path)))
  const isMutationPath = path !== undefined && mutationPaths.some((pattern) => pattern.test(path))
  const isAllowedMethod = req.method === 'GET' ? isReadPath : ['POST', 'PATCH', 'DELETE'].includes(req.method ?? '') && isMutationPath
  if (!path || !isAllowedMethod || !projectRef) {
    return res.status(404).json({ error: { message: 'Resource not found' } })
  }
  if (req.method !== 'GET' && typeof req.headers['idempotency-key'] !== 'string') {
    return res.status(400).json({ error: { message: 'Idempotency key is required' } })
  }
  if (req.headers[tenantHeaders.projectId] !== projectRef) {
    return res.status(403).json({ error: { message: 'Tenant mismatch' } })
  }

  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) {
    return res.status(503).json({ error: { message: 'Studio backend is not configured' } })
  }

  const headers = new Headers({ accept: 'application/json' })
  for (const name of forwardedHeaders) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  if (typeof req.headers['idempotency-key'] === 'string') {
    headers.set('idempotency-key', req.headers['idempotency-key'])
  }
  if (req.method !== 'GET') headers.set('content-type', 'application/json')

  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/${path}`, {
      method: req.method,
      headers,
      ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }),
      signal: controller.signal,
    })
    const body = await response.arrayBuffer()
    const contentType = response.headers.get('content-type')
    const correlationId = response.headers.get(tenantHeaders.correlationId)
    if (contentType) res.setHeader('content-type', contentType)
    if (correlationId) res.setHeader(tenantHeaders.correlationId, correlationId)
    return res.status(response.status).send(Buffer.from(body))
  } catch (error) {
    if (controller.signal.aborted) return
    return res.status(503).json({ error: { message: 'Studio backend is unavailable' } })
  }
}
