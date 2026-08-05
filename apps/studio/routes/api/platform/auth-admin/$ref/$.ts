import { createFileRoute } from '@tanstack/react-router'

import { toWebHandler } from '@/compat/next/api'
import nextHandler from '@/pages/api/platform/auth-admin/[ref]/[...path]'

const handleNextRequest = toWebHandler(nextHandler)

export const Route = createFileRoute('/api/platform/auth-admin/$ref/$')({
  server: {
    handlers: {
      GET: handleRequest,
      POST: handleRequest,
      PUT: handleRequest,
    },
  },
})

function handleRequest({
  request,
  params,
}: Readonly<{
  request: Request
  params: Readonly<{ ref: string; _splat?: string }>
}>): Promise<Response> {
  return handleNextRequest({
    request,
    params: { ref: params.ref, path: params._splat },
  })
}
