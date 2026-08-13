import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/props/project/[ref]'))

export const Route = createFileRoute('/api/platform/props/project/$ref/')({
  server: { handlers: { GET: handler } },
})
