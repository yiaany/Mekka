import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(
  () => import('@/pages/api/v1/projects/[ref]/config/auth/signing-keys/legacy')
)

export const Route = createFileRoute('/api/v1/projects/$ref/config/auth/signing-keys/legacy')({
  server: { handlers: { GET: handler } },
})
