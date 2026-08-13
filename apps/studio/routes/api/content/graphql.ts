import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/content/graphql'))

export const Route = createFileRoute('/api/content/graphql')({
  server: { handlers: { POST: handler } },
})
