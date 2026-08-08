import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/platform/mcp/approvals')({
  server: { handlers: { GET: handleRequest } },
})

async function handleRequest(): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
  if (!backendUrl || !internalProxyToken) {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
  try {
    return await fetch(`${backendUrl.replace(/\/$/, '')}/mcp-admin/approvals`, {
      headers: { 'x-mekka-internal-proxy': internalProxyToken },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}
