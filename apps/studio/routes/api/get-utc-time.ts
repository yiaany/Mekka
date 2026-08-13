import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/get-utc-time'))

export const Route = createFileRoute('/api/get-utc-time')({
  server: { handlers: { GET: handler } },
})
