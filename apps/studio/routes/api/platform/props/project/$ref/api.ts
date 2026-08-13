import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/platform/props/project/[ref]/api'))

export const Route = createFileRoute('/api/platform/props/project/$ref/api')({
  server: { handlers: { GET: handler } },
})
