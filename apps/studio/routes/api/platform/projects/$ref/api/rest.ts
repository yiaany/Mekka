import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/projects/[ref]/api/rest'))

export const Route = createFileRoute('/api/platform/projects/$ref/api/rest')({
  server: { handlers: { GET: handler, HEAD: handler } },
})
