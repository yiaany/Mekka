import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/pg-meta/[ref]/triggers'))

export const Route = createFileRoute('/api/platform/pg-meta/$ref/triggers')({
  server: { handlers: { GET: handler } },
})
