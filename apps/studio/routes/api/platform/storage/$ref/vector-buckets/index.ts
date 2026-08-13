import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/storage/[ref]/vector-buckets'))

export const Route = createFileRoute('/api/platform/storage/$ref/vector-buckets/')({
  server: { handlers: { GET: handler, POST: handler } },
})
