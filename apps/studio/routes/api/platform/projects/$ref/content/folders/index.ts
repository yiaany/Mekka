import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/content/folders')
)

export const Route = createFileRoute('/api/platform/projects/$ref/content/folders/')({
  server: { handlers: { GET: handler, POST: handler, DELETE: handler } },
})
