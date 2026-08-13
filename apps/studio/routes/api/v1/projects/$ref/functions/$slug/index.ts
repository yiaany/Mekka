import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/v1/projects/[ref]/functions/[slug]'))

export const Route = createFileRoute('/api/v1/projects/$ref/functions/$slug/')({
  server: { handlers: { GET: handler } },
})
