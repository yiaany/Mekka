import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/infra-monitoring')
)

export const Route = createFileRoute('/api/platform/projects/$ref/infra-monitoring')({
  server: { handlers: { GET: handler } },
})
