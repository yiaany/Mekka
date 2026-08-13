import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/auth/[ref]/users/[id]'))

export const Route = createFileRoute('/api/platform/auth/$ref/users/$id/')({
  server: { handlers: { PATCH: handler, DELETE: handler } },
})
