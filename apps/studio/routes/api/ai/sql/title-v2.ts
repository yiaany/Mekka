import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/title-v2'))

export const Route = createFileRoute('/api/ai/sql/title-v2')({
  server: { handlers: { POST: handler } },
})
