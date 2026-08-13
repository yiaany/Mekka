import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/storage/[ref]/vector-buckets/[id]/indexes')
)

export const Route = createFileRoute('/api/platform/storage/$ref/vector-buckets/$id/indexes/')({
  server: { handlers: { GET: handler, POST: handler } },
})
