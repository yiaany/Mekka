import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/integrations/[slug]'))

export const Route = createFileRoute('/api/platform/integrations/$slug')({
  server: { handlers: { GET: handler } },
})
