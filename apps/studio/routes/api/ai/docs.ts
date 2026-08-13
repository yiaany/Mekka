import { createFileRoute } from '@tanstack/react-router'
import type { NextRequest } from 'next/server'

export const Route = createFileRoute('/api/ai/docs')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { default: docsHandler } = await import('@/pages/api/ai/docs')
        return docsHandler(request as NextRequest)
      },
    },
  },
})
