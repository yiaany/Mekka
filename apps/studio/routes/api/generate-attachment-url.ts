import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/generate-attachment-url'))

export const Route = createFileRoute('/api/generate-attachment-url')({
  server: { handlers: { POST: handler } },
})
