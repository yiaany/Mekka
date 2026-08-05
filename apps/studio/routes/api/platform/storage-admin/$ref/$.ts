import { createFileRoute } from '@tanstack/react-router'

import { handleStorageAdminWebRequest } from '@/lib/storage-admin-web-proxy'

export const Route = createFileRoute('/api/platform/storage-admin/$ref/$')({
  server: {
    handlers: {
      GET: handleRequest,
      HEAD: handleRequest,
      POST: handleRequest,
      PUT: handleRequest,
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
  return handleStorageAdminWebRequest(request, params.ref, params._splat)
}
