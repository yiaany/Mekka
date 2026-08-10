import { createFileRoute } from '@tanstack/react-router'

import { handleApprovalDecisionRequest } from '@/lib/mekka-platform-handlers'

export const handleRequest = handleApprovalDecisionRequest

export const Route = createFileRoute('/api/platform/mcp/approvals/$approvalId')({
  server: { handlers: { PATCH: handleRequest } },
})
