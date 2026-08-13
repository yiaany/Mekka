import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/parse-query'))

export const Route = createFileRoute('/api/parse-query')({
  server: { handlers: { POST: handler } },
})
