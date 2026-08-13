import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/billing/addons')
)

export const Route = createFileRoute('/api/platform/projects/$ref/billing/addons')({
  server: { handlers: { GET: handler } },
})
