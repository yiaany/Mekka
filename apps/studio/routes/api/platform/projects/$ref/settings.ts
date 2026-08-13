import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects/[ref]/settings'))

export const Route = createFileRoute('/api/platform/projects/$ref/settings')({
  server: { handlers: { GET: handler } },
})
