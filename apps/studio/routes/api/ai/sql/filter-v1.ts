import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/filter-v1'))

export const Route = createFileRoute('/api/ai/sql/filter-v1')({
  server: { handlers: { POST: handler } },
})
