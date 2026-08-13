import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/analytics/log-drains')
)

export const Route = createFileRoute('/api/platform/projects/$ref/analytics/log-drains')({
  server: { handlers: { GET: handler, POST: handler } },
})
