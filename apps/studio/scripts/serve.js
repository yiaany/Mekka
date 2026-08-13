#!/usr/bin/env node
// Standalone Node HTTP server that hosts the production studio build.
//
// We export the fetch-handler shape from `dist/server/server.js` because
// Vercel consumes it directly (see `apps/studio/api/server.js`). For
// self-hosted / e2e, we need an HTTP listener of our own — this is that
// listener.
//
// Responsibilities:
//   - Load env files in vite preview's order so non-NEXT_PUBLIC_* values
//     (POSTGRES_PASSWORD, PG_META_CRYPTO_KEY, etc.) are in process.env
//     at request time. NEXT_PUBLIC_* are already inlined into the bundle
//     at build time and don't need to be re-loaded.
//   - Serve static client assets from `dist/client/` directly with the
//     right MIME types and cache headers.
//   - Forward everything else to the TanStack Start handler exported
//     from `dist/server/server.js`.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readEnvFiles } from './lib/env.js'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = path.join(studioRoot, 'dist/client')
const mode = process.env.MODE || 'production'

const envFiles = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
const parsed = readEnvFiles(studioRoot, envFiles)
// Don't clobber values the shell already provides — match `vite preview`.
for (const [k, v] of Object.entries(parsed)) {
  if (process.env[k] !== undefined) continue
  process.env[k] = v.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (_, name) => process.env[name] ?? parsed[name] ?? ''
  )
}

const accessToken = process.env.MEKKA_STUDIO_ACCESS_TOKEN
const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN
const maxMcpRequestBytes = 1_000_000
const sqliteMetaReadPaths = new Set(['tables', 'schema/health', 'columns', 'indexes'])
const sqliteMetaReadPathPatterns = [
  /^tables\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
]
const sqliteMetaMutationPaths = [
  /^tables$/,
  /^tables\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^columns$/,
  /^columns\/[A-Za-z_][A-Za-z0-9_]{0,63}\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^indexes$/,
  /^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^sql$/,
]
if (process.env.NODE_ENV === 'production') {
  if (!accessToken || accessToken.length < 24) {
    throw new Error('MEKKA_STUDIO_ACCESS_TOKEN must contain at least 24 characters in production')
  }
  if (!internalProxyToken || internalProxyToken.length < 24) {
    throw new Error('MEKKA_INTERNAL_PROXY_TOKEN must contain at least 24 characters in production')
  }
}

let handlerPromise

async function getDynamicHandler() {
  handlerPromise ??= (async () => {
    // Static Studio pages do not need the React/Start server graph. Load it,
    // and server-side Sentry, only when an API/Auth/MCP request actually needs it.
    try {
      await import(pathToFileURL(path.join(studioRoot, 'instrument.server.mjs')).href)
    } catch (err) {
      console.warn('[serve] Sentry server init skipped:', err?.message ?? err)
    }
    const { wrapFetchWithSentry } = await import('@sentry/tanstackstart-react').catch(() => ({
      wrapFetchWithSentry: (fetchHandler) => fetchHandler,
    }))
    const { default: rawHandler } = await import(
      pathToFileURL(path.join(studioRoot, 'dist/server/server.js')).href
    )
    return {
      ...rawHandler,
      fetch: wrapFetchWithSentry(rawHandler.fetch.bind(rawHandler)),
    }
  })()
  return handlerPromise
}

const mimeByExt = new Map([
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
])

// Vite emits hashed filenames (e.g. `index-DB4J79t9.js`) for everything
// it bundles. Those are content-addressed so we serve them immutable.
const HASHED_RE = /-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/

async function serveStatic(req, res) {
  let pathname
  try {
    pathname = new URL(req.url, 'http://localhost').pathname
  } catch {
    return false
  }
  if (pathname === '/' || pathname.endsWith('/')) return false
  if (pathname.includes('..') || pathname.includes('\\')) return false
  const filePath = path.join(clientDir, pathname)
  if (!filePath.startsWith(clientDir + path.sep)) return false

  let st
  try {
    st = await stat(filePath)
  } catch {
    return false
  }
  if (!st.isFile()) return false

  res.statusCode = 200
  res.setHeader(
    'content-type',
    mimeByExt.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream'
  )
  res.setHeader('content-length', String(st.size))
  res.setHeader(
    'cache-control',
    HASHED_RE.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('end', resolve)
    stream.pipe(res)
  })
  return true
}

function toWebRequest(req, targetUrl) {
  const protocol = req.socket.encrypted ? 'https' : 'http'
  const url = targetUrl ?? `${protocol}://${req.headers.host ?? 'localhost'}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith(':')) continue
    if (Array.isArray(v)) for (const vv of v) headers.append(k, vv)
    else if (v !== undefined) headers.set(k, v)
  }
  if (internalProxyToken) headers.set('x-mekka-internal-proxy', internalProxyToken)
  const init = { method: req.method, headers }
  // Only attach a body for methods that can carry one AND that actually
  // have body bytes coming. Wrapping `req` in `Readable.toWeb(req)` for
  // requests where Node has nothing to deliver leaves undici's
  // `extractBody` looking at an already-consumed stream and throwing
  // `TypeError: Response body object should not be disturbed or locked`
  // at the `new Request(...)` call below.
  const contentLength = Number(req.headers['content-length'] ?? '0')
  const hasBody =
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    (contentLength > 0 || req.headers['transfer-encoding'] === 'chunked')
  if (hasBody) {
    init.body = Readable.toWeb(req)
    init.duplex = 'half'
  }
  return new Request(url, init)
}

function sqliteMetaBackendUrl(pathname, search, method) {
  const match = pathname.match(/^\/api\/platform\/sqlite-meta\/local\/(.+)$/)
  if (!match) return null
  const resourcePath = match[1]
  const isRead =
    sqliteMetaReadPaths.has(resourcePath) ||
    sqliteMetaReadPathPatterns.some((pattern) => pattern.test(resourcePath))
  const isMutation = sqliteMetaMutationPaths.some((pattern) => pattern.test(resourcePath))
  if (
    !((isRead && ['GET', 'HEAD'].includes(method)) ||
      (isMutation && ['POST', 'PATCH', 'DELETE'].includes(method)))
  ) {
    return null
  }
  const backend = process.env.STUDIO_BACKEND_API_URL
  if (!backend) return null
  return `${backend.replace(/\/$/, '')}/${resourcePath}${search}`
}

async function proxySqliteMeta(req, res, targetUrl) {
  const request = toWebRequest(req, targetUrl)
  request.headers.set('x-mekka-organization-id', process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? 'org-local')
  request.headers.set('x-mekka-project-id', 'local')
  request.headers.set('x-mekka-environment-id', process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? 'env-local')
  request.headers.set('x-mekka-branch-id', process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? 'branch-main')
  request.headers.set('x-mekka-generation', process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? '1')
  const controller = new AbortController()
  const abort = () => controller.abort()
  req.once('aborted', abort)
  res.once('close', abort)
  const timeout = setTimeout(abort, 10_000)
  try {
    const response = await fetch(request, { signal: controller.signal })
    await pipeWebResponse(response, res)
  } finally {
    clearTimeout(timeout)
    req.removeListener('aborted', abort)
    res.removeListener('close', abort)
  }
}

async function serveShell(res) {
  const filePath = path.join(clientDir, '_shell.html')
  const st = await stat(filePath)
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('content-length', String(st.size))
  res.setHeader('cache-control', 'no-cache')
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('end', resolve)
    stream.pipe(res)
  })
}

function isDynamicPath(pathname) {
  return (
    pathname === '/mcp' ||
    pathname === '/.well-known/oauth-protected-resource/mcp' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_serverFn/')
  )
}

function isHealthRequest(req) {
  const pathname = new URL(req.url, 'http://localhost').pathname
  return pathname.endsWith('/api/health/live') || pathname.endsWith('/api/health/ready')
}

function isAuthorized(req) {
  if (process.env.NODE_ENV !== 'production') return true
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Basic ')) return false

  let password
  try {
    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    password = decoded.slice(separator + 1)
  } catch {
    return false
  }

  const actual = Buffer.from(password)
  const expected = Buffer.from(accessToken)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function pipeWebResponse(response, res) {
  res.statusCode = response.status
  // The Headers iterator collapses duplicate keys, and for `set-cookie` it joins
  // every cookie into one comma-separated value — which corrupts auth/session
  // cookies. Pull the cookies out separately via getSetCookie() and set them as
  // an array so each one becomes its own header.
  const setCookies =
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const [k, v] of response.headers) {
    if (k.toLowerCase() === 'set-cookie') continue
    res.setHeader(k, v)
  }
  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies)
  if (!response.body) {
    res.end()
    return
  }
  // Pipe via Readable.fromWeb so the underlying stream gets proper backpressure
  // and gets released cleanly. `for await (chunk of response.body)` works in
  // simple cases but can leave the body in a "disturbed / locked" state when
  // the handler internally peeks at it — surfacing as
  // `TypeError: Response body object should not be disturbed or locked` on a
  // subsequent request.
  await new Promise((resolve, reject) => {
    const readable = Readable.fromWeb(response.body)
    readable.on('error', reject)
    res.on('error', reject)
    res.on('close', resolve)
    res.on('finish', resolve)
    readable.pipe(res)
  })
}

// Security headers for the self-hosted server. Mirrors the non-platform branch
// of next.config.ts `headers()` (self-hosted is always IS_PLATFORM=false, so the
// CSP is just `frame-ancestors 'none'` and there's no HSTS). The platform CSP is
// applied at the edge via vercel.ts instead; see security-headers.ts. Set before
// any response is written so both the static and handler paths inherit them.
const SECURITY_HEADERS = [
  ['X-Frame-Options', 'DENY'],
  ['X-Content-Type-Options', 'nosniff'],
  ['Content-Security-Policy', "frame-ancestors 'none';"],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
]

const port = Number(process.env.PORT || 8082)
createServer(async (req, res) => {
  try {
    for (const [key, value] of SECURITY_HEADERS) res.setHeader(key, value)
    const rawPathname = new URL(req.url ?? '/', 'http://studio.local').pathname
    const pathname = rawPathname.length > 1 ? rawPathname.replace(/\/$/, '') : rawPathname
    const isAgentAccessRequest =
      pathname === '/mcp' || pathname === '/.well-known/oauth-protected-resource/mcp'
    const isApplicationAccessRequest =
      pathname.startsWith('/api/platform/mcp/approvals') &&
      /^Bearer [A-Za-z0-9._~-]+$/.test(req.headers.authorization ?? '')
    if (pathname === '/mcp') {
      if (!/^Bearer [A-Za-z0-9._~-]+$/.test(req.headers.authorization ?? '')) {
        const protocol = req.socket.encrypted ? 'https' : 'http'
        const metadataUrl = new URL(
          '/.well-known/oauth-protected-resource/mcp',
          `${protocol}://${req.headers.host ?? 'localhost'}`
        )
        res.statusCode = 401
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('www-authenticate', `Bearer resource_metadata="${metadataUrl.href}"`)
        res.end(JSON.stringify({ error: 'auth' }))
        return
      }
      const contentLength = Number(req.headers['content-length'] ?? '0')
      if (Number.isFinite(contentLength) && contentLength > maxMcpRequestBytes) {
        res.statusCode = 413
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: 'payload_too_large' }))
        return
      }
    }
    if (
      !isHealthRequest(req) &&
      !isAgentAccessRequest &&
      !isApplicationAccessRequest &&
      !isAuthorized(req)
    ) {
      res.statusCode = 401
      res.setHeader('www-authenticate', 'Basic realm="Mekka Studio", charset="UTF-8"')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: { message: 'Authentication required' } }))
      return
    }
    if (await serveStatic(req, res)) return
    const sqliteMetaUrl = sqliteMetaBackendUrl(
      pathname,
      new URL(req.url ?? '/', 'http://studio.local').search,
      req.method ?? 'GET'
    )
    if (sqliteMetaUrl !== null) {
      await proxySqliteMeta(req, res, sqliteMetaUrl)
      return
    }
    if (!isDynamicPath(pathname)) {
      if (path.extname(pathname)) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      await serveShell(res)
      return
    }
    const handler = await getDynamicHandler()
    const response = await handler.fetch(toWebRequest(req))
    await pipeWebResponse(response, res)
  } catch (err) {
    console.error('[serve] request failed:', err)
    if (!res.headersSent) {
      res.statusCode = 500
      res.setHeader('content-type', 'text/plain; charset=utf-8')
    }
    res.end('Internal Server Error')
  }
}).listen(port, () => {
  console.log(`Studio listening on http://localhost:${port} (mode=${mode})`)
})
