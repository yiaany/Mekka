import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/auth/[ref]/magiclink'))

export const Route = createFileRoute('/api/platform/auth/$ref/magiclink')({
  server: { handlers: { POST: handler } },
})
