import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/content/folders/[id]')
)

export const Route = createFileRoute('/api/platform/projects/$ref/content/folders/$id')({
  server: { handlers: { GET: handler, PATCH: handler } },
})
