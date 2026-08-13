import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects'))

export const Route = createFileRoute('/api/platform/projects/')({
  server: { handlers: { GET: handler } },
})
