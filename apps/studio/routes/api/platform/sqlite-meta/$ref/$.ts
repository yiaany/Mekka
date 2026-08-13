import { createFileRoute } from '@tanstack/react-router'

import { toLazyWebHandler } from '@/compat/next/api'

const handleNextRequest = toLazyWebHandler(
  () => import('@/pages/api/platform/sqlite-meta/[ref]/[...path]')
)

export const Route = createFileRoute('/api/platform/sqlite-meta/$ref/$')({
  server: {
    handlers: {
      GET: handleRequest,
      POST: handleRequest,
      PATCH: handleRequest,
      DELETE: handleRequest,
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
  return handleNextRequest({ request, params: { ref: params.ref, path: params._splat } })
}
