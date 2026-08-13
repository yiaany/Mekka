import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/integrations/github/connections')
)

export const Route = createFileRoute('/api/platform/integrations/github/connections')({
  server: { handlers: { GET: handler } },
})
