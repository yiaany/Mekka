import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/policy'))

export const Route = createFileRoute('/api/ai/sql/policy')({
  server: { handlers: { POST: handler } },
})
