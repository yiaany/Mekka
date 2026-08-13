import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/deployment-mode'))

export const Route = createFileRoute('/api/platform/deployment-mode')({
  server: { handlers: { GET: handler } },
})
