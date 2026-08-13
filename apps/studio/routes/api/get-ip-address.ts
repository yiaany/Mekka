import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/get-ip-address'))

export const Route = createFileRoute('/api/get-ip-address')({
  server: { handlers: { GET: handler } },
})
