import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/telemetry/event'))

export const Route = createFileRoute('/api/platform/telemetry/event')({
  server: { handlers: { POST: handler } },
})
