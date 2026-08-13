import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/auth/[ref]/recover'))

export const Route = createFileRoute('/api/platform/auth/$ref/recover')({
  server: { handlers: { POST: handler } },
})
