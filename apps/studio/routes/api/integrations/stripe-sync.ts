import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/integrations/stripe-sync'))

export const Route = createFileRoute('/api/integrations/stripe-sync')({
  server: { handlers: { POST: handler, DELETE: handler } },
})
