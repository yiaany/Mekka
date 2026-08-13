import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handler = toLazyWebHandler(() => import('@/pages/api/ai/onboarding/design'))

export const Route = createFileRoute('/api/ai/onboarding/design')({
  server: { handlers: { POST: handler } },
})
