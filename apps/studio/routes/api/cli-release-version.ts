import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/cli-release-version'))

export const Route = createFileRoute('/api/cli-release-version')({
  server: { handlers: { GET: handler } },
})
