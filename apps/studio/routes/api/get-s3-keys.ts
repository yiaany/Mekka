import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/get-s3-keys'))

export const Route = createFileRoute('/api/get-s3-keys')({
  server: { handlers: { GET: handler } },
})
