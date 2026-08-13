import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/status-override'))

export const Route = createFileRoute('/api/status-override')({
  server: { handlers: { GET: handler } },
})
