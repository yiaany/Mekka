import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/config/postgrest')
)

export const Route = createFileRoute('/api/platform/projects/$ref/config/postgrest')({
  server: { handlers: { GET: handler } },
})
