import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/enabled-features-overrides'))

export const Route = createFileRoute('/api/enabled-features-overrides')({
  server: { handlers: { GET: handler } },
})
