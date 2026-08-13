import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/platform/projects/[ref]/config/secrets/update-status')
)

export const Route = createFileRoute('/api/platform/projects/$ref/config/secrets/update-status')({
  server: { handlers: { GET: handler } },
})
