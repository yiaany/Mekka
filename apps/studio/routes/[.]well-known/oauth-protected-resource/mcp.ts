import { createFileRoute } from '@tanstack/react-router'

import { proxyMcpRequest } from '@/routes/mcp'

export const Route = createFileRoute('/.well-known/oauth-protected-resource/mcp')({
  server: {
    handlers: {
      GET: ({ request }) => proxyMcpRequest(request, '/.well-known/oauth-protected-resource/mcp'),
    },
  },
})
