import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/pg-meta/[ref]/types'))

export const Route = createFileRoute('/api/platform/pg-meta/$ref/types')({
  server: { handlers: { GET: handler } },
})
