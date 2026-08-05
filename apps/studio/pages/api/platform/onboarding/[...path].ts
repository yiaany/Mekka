import type { NextApiRequest, NextApiResponse } from 'next'

const allowedPaths = new Set(['onboarding'])

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const path = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path
  const isRetry = typeof path === 'string' && /^onboarding\/[A-Za-z0-9_-]{3,128}\/retry$/.test(path)
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ error: { message: 'Method not allowed' } })
  }
  if (!path || (!allowedPaths.has(path) && !isRetry)) {
    return res.status(404).json({ error: { message: 'Resource not found' } })
  }
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return res.status(503).json({ error: { message: 'Studio backend is not configured' } })

  const idempotencyKey = req.headers['idempotency-key']
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    return res.status(400).json({ error: { message: 'Invalid idempotency key' } })
  }
  const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': idempotencyKey })
  const authorization = req.headers.authorization
  const correlationId = req.headers['x-correlation-id']
  if (typeof authorization === 'string') headers.set('authorization', authorization)
  if (typeof correlationId === 'string') headers.set('x-correlation-id', correlationId)

  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/${path}`, {
      method: 'POST', headers, signal: controller.signal,
      ...(isRetry ? {} : { body: JSON.stringify(req.body) }),
    })
    const body = await response.arrayBuffer()
    const responseCorrelationId = response.headers.get('x-correlation-id')
    if (responseCorrelationId) res.setHeader('x-correlation-id', responseCorrelationId)
    return res.status(response.status).send(Buffer.from(body))
  } catch {
    if (controller.signal.aborted) return
    return res.status(503).json({ error: { message: 'Studio backend is unavailable' } })
  }
}
