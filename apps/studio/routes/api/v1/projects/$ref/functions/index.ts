import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/v1/projects/[ref]/functions'))

export const Route = createFileRoute('/api/v1/projects/$ref/functions/')({
  server: { handlers: { GET: handler } },
})
