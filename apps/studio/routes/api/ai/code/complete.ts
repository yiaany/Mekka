import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/code/complete'))

export const Route = createFileRoute('/api/ai/code/complete')({
  server: { handlers: { POST: handler } },
})
