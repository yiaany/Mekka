import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/profile'))

export const Route = createFileRoute('/api/platform/profile/')({
  server: { handlers: { GET: handler } },
})
