import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/v1/projects/[ref]/database/migrations')
)

export const Route = createFileRoute('/api/v1/projects/$ref/database/migrations')({
  server: { handlers: { GET: handler, POST: handler } },
})
