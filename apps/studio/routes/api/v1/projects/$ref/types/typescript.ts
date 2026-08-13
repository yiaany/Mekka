import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/v1/projects/[ref]/types/typescript'))

export const Route = createFileRoute('/api/v1/projects/$ref/types/typescript')({
  server: { handlers: { GET: handler } },
})
