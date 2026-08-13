import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/analytics/log-drains/[uuid]')
)

export const Route = createFileRoute('/api/platform/projects/$ref/analytics/log-drains/$uuid')({
  server: { handlers: { GET: handler, PUT: handler, DELETE: handler } },
})
