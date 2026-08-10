import { createFileRoute } from '@tanstack/react-router'

import { handleAgentTokenRequest } from '@/lib/mekka-platform-handlers'

export const handleRequest = handleAgentTokenRequest

export const Route = createFileRoute('/api/platform/project-auth/$ref/agent-token')({
  server: { handlers: { POST: handleRequest } },
})
