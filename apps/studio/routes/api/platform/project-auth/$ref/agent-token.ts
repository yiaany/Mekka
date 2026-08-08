import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/platform/project-auth/$ref/agent-token')({
  server: { handlers: { POST: handleRequest } },
})

async function handleRequest({
  request,
  params,
}: {
  request: Request
  params: { ref: string }
}): Promise<Response> {
  if (params.ref !== 'local') return Response.json({ error: 'not_found' }, { status: 404 })
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })
  const payload: unknown = await request.json().catch(() => ({}))
  if (!hasAccessToken(payload)) return Response.json({ error: 'validation' }, { status: 400 })
  return fetch(`${backendUrl.replace(/\/$/, '')}/auth-local/agent-token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${payload.accessToken}` },
    signal: AbortSignal.timeout(5_000),
  })
}

function hasAccessToken(payload: unknown): payload is { accessToken: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'accessToken' in payload &&
    typeof payload.accessToken === 'string'
  )
}
