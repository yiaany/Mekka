import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/storage/[ref]/buckets/[id]'))

export const Route = createFileRoute('/api/platform/storage/$ref/buckets/$id/')({
  server: { handlers: { GET: handler, PATCH: handler, DELETE: handler } },
})
