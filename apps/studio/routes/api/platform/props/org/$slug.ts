import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/props/org/[slug]'))

export const Route = createFileRoute('/api/platform/props/org/$slug')({
  server: { handlers: { GET: handler } },
})
