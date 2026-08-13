import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/check-api-key'))

export const Route = createFileRoute('/api/ai/sql/check-api-key')({
  server: { handlers: { GET: handler } },
})
