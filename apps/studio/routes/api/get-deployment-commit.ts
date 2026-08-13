import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/get-deployment-commit'))

export const Route = createFileRoute('/api/get-deployment-commit')({
  server: { handlers: { GET: handler } },
})
