import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/check-cname'))

export const Route = createFileRoute('/api/check-cname')({
  server: { handlers: { GET: handler } },
})
