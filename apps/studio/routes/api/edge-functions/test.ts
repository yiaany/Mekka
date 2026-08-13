import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/edge-functions/test'))

export const Route = createFileRoute('/api/edge-functions/test')({
  server: { handlers: { POST: handler } },
})
