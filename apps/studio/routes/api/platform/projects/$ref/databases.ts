import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects/[ref]/databases'))

export const Route = createFileRoute('/api/platform/projects/$ref/databases')({
  server: { handlers: { GET: handler } },
})
