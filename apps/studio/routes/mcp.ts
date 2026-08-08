import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/mcp')({
  server: { handlers: { GET: proxyMcp, POST: proxyMcp, DELETE: proxyMcp } },
})

async function proxyMcp({ request }: { request: Request }): Promise<Response> {
  return proxyMcpRequest(request, '/mcp')
}

export async function proxyMcpRequest(request: Request, path: string): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL
  if (!backendUrl) return Response.json({ error: 'unavailable' }, { status: 503 })

  try {
    const headers = new Headers(request.headers)
    for (const name of ['connection', 'content-length', 'expect', 'host', 'transfer-encoding']) {
      headers.delete(name)
    }
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    return await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    console.error('MCP proxy failed', error)
    return Response.json({ error: 'unavailable' }, { status: 503 })
  }
}
