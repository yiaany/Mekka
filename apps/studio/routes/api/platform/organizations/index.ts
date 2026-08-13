import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/organizations'))

export const Route = createFileRoute('/api/platform/organizations/')({
  server: { handlers: { GET: handler } },
})
