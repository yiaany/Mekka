export type VercelRedirect = Readonly<{
  source: string
  destination: string
  permanent?: boolean
  statusCode?: number
}>

export type VercelRewrite = Readonly<{
  source: string
  destination: string
}>

export type VercelHeader = Readonly<{
  key: string
  value: string
}>

export type VercelHeaderRule = Readonly<{
  source: string
  headers: readonly VercelHeader[]
}>

export type VercelConfig = Readonly<{
  framework?: string | null
  outputDirectory?: string
  cleanUrls?: boolean
  redirects?: readonly VercelRedirect[]
  rewrites?: readonly VercelRewrite[]
  headers?: readonly VercelHeaderRule[]
  functions?: Readonly<
    Record<
      string,
      Readonly<{
        maxDuration?: number
        includeFiles?: string
      }>
    >
  >
}>

type CacheDuration = '1day' | '30days' | '1year'

type CacheOptions = Readonly<{
  public?: boolean
  private?: boolean
  noStore?: boolean
  immutable?: boolean
  maxAge?: CacheDuration
}>

const durationSeconds = Object.freeze({
  '1day': 86_400,
  '30days': 2_592_000,
  '1year': 31_557_600,
} satisfies Record<CacheDuration, number>)

export const vercelRoutes = Object.freeze({
  rewrite(source: string, destination: string): VercelRewrite {
    return Object.freeze({ source, destination })
  },

  cacheControl(source: string, options: CacheOptions): VercelHeaderRule {
    const visibility = options.public === true ? 'public' : options.private === true ? 'private' : null
    const directives = [
      visibility,
      options.maxAge === undefined ? null : `max-age=${durationSeconds[options.maxAge]}`,
      options.noStore === true ? 'no-store' : null,
      options.immutable === true ? 'immutable' : null,
    ].filter((directive): directive is string => directive !== null)

    if (directives.length === 0 || (options.public === true && options.private === true)) {
      throw new Error('Invalid Vercel cache options')
    }

    return Object.freeze({
      source,
      headers: Object.freeze([
        Object.freeze({ key: 'Cache-Control', value: directives.join(', ') }),
      ]),
    })
  },
})
