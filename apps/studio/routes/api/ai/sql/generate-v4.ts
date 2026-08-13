import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/generate-v4'))

export const Route = createFileRoute('/api/ai/sql/generate-v4')({
  server: { handlers: { POST: handler } },
})
