import { NextResponse, type NextRequest } from 'next/server'

import { IS_PLATFORM } from '@/lib/constants'
import { getForkRouteRedirect } from '@/lib/fork-routing'
import { isHostedSupportedApiPath } from '@/lib/hosted-api-allowlist'

export const config = {
  matcher: [
    '/api/:function*',
    '/((?!api|_next/static|_next/image|favicon|img|manifest.json|site.webmanifest).*)',
  ],
}

// Return 404 for all next.js API endpoints EXCEPT the ones we use in hosted.
// The allowlist is shared with the TanStack guard (start.ts) — see
// lib/hosted-api-allowlist.ts.
export function proxy(request: NextRequest) {
  if (!request.nextUrl.pathname.startsWith('/api/')) {
    const forkRedirect = getForkRouteRedirect(request.nextUrl.pathname)
    if (forkRedirect) return NextResponse.redirect(new URL(forkRedirect, request.url))
  }

  if (IS_PLATFORM && !isHostedSupportedApiPath(request.nextUrl.pathname)) {
    return Response.json(
      { success: false, message: 'Endpoint not supported on hosted' },
      { status: 404 }
    )
  }
}
