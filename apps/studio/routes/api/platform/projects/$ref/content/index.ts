import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects/[ref]/content'))

export const Route = createFileRoute('/api/platform/projects/$ref/content/')({
  server: { handlers: { GET: handler, PUT: handler, DELETE: handler } },
})
