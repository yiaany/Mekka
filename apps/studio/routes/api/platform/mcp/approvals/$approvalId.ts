import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/platform/mcp/approvals/$approvalId')({
  server: { handlers: { PATCH: handleRequest } },
})

async function handleRequest({
  request,
  params,
}: {
  request: Request
  params: { approvalId: string }
}): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
  if (!backendUrl || !internalProxyToken) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  const body = await request.text()
  if (body.length === 0 || body.length > 1_024) {
    return Response.json({ error: 'validation' }, { status: 400 })
  }
  try {
    return await fetch(
      `${backendUrl.replace(/\/$/, '')}/mcp-admin/approvals/${encodeURIComponent(params.approvalId)}`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-mekka-internal-proxy': internalProxyToken,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      }
    )
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}
