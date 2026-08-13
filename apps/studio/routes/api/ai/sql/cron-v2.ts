import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/sql/cron-v2'))

export const Route = createFileRoute('/api/ai/sql/cron-v2')({
  server: { handlers: { POST: handler } },
})
