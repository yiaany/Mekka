import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects/[ref]/run-lints'))

export const Route = createFileRoute('/api/platform/projects/$ref/run-lints')({
  server: { handlers: { GET: handler } },
})
