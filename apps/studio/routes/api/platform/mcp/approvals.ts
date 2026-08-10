import { createFileRoute } from '@tanstack/react-router'

import { handleApprovalListRequest } from '@/lib/mekka-platform-handlers'

export const handleRequest = handleApprovalListRequest

export const Route = createFileRoute('/api/platform/mcp/approvals')({
  server: { handlers: { GET: handleRequest } },
})
