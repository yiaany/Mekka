import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/integrations/github/authorization')
)

export const Route = createFileRoute('/api/platform/integrations/github/authorization')({
  server: { handlers: { GET: handler } },
})
