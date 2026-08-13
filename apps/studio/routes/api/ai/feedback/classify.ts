import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/feedback/classify'))

export const Route = createFileRoute('/api/ai/feedback/classify')({
  server: { handlers: { POST: handler } },
})
