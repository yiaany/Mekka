import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/database/[ref]/pooling'))

export const Route = createFileRoute('/api/platform/database/$ref/pooling')({
  server: { handlers: { GET: handler, PATCH: handler } },
})
