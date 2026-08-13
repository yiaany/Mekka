import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/feedback/rate'))

export const Route = createFileRoute('/api/ai/feedback/rate')({
  server: { handlers: { POST: handler } },
})
