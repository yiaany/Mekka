import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/storage/[ref]/buckets/[id]/objects/sign')
)

export const Route = createFileRoute('/api/platform/storage/$ref/buckets/$id/objects/sign')({
  server: { handlers: { POST: handler } },
})
