import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/storage/[ref]/vector-buckets/[id]')
)

export const Route = createFileRoute('/api/platform/storage/$ref/vector-buckets/$id/')({
  server: { handlers: { GET: handler, DELETE: handler } },
})
