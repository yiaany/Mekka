import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/analytics/endpoints/[name]')
)

export const Route = createFileRoute('/api/platform/projects/$ref/analytics/endpoints/$name')({
  server: { handlers: { GET: handler, POST: handler } },
})
