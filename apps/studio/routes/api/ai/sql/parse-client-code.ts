import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/parse-client-code'))

export const Route = createFileRoute('/api/ai/sql/parse-client-code')({
  server: { handlers: { POST: handler } },
})
