import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/connect'))

export const Route = createFileRoute('/api/connect/')({
  server: { handlers: { GET: handler } },
})
