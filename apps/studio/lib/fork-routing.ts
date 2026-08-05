const ENABLED_PROJECT_AREAS = new Set(['editor', 'sql', 'auth'])
const ENABLED_AUTH_PATHS = new Set(['users', 'providers', 'url-configuration', 'templates'])
const ENABLED_PUBLIC_PATHS = new Set(['/404', '/500', '/logout', '/maintenance', '/onboarding', '/sign-in'])

export function getForkProjectRedirect(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== 'project' || !segments[1]) return undefined
  if (segments[1] === '_') return '/project/local/editor'
  if (segments.length === 2) return `/project/${segments[1]}/editor`
  if (segments[2] === 'auth') {
    if (segments.length === 4 && ENABLED_AUTH_PATHS.has(segments[3])) return undefined
    return `/project/${segments[1]}/auth/users`
  }
  if (ENABLED_PROJECT_AREAS.has(segments[2])) return undefined

  return `/project/${segments[1]}/editor`
}

export function getForkRouteRedirect(pathname: string): string | undefined {
  const normalizedPathname = pathname !== '/' ? pathname.replace(/\/$/, '') : pathname
  const projectRedirect = getForkProjectRedirect(normalizedPathname)

  if (projectRedirect) return projectRedirect
  if (normalizedPathname === '/api' || normalizedPathname.startsWith('/api/')) return undefined
  if (normalizedPathname.startsWith('/project/')) return undefined
  if (ENABLED_PUBLIC_PATHS.has(normalizedPathname)) return undefined

  return '/project/local/editor'
}
