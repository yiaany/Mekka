import { IS_PROD } from './constants'
import { isBrowser } from './helpers'

const SAFE_ATTRIBUTION_QUERY_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'fbclid',
  'rdt_cid',
  'ttclid',
  'twclid',
  'li_fat_id',
])

export function isSafeTelemetryAttributionKey(key: string): boolean {
  return SAFE_ATTRIBUTION_QUERY_KEYS.has(key.toLowerCase())
}

export function sanitizeTelemetrySearch(search: string): string {
  const safeParams = new URLSearchParams()

  for (const [key, value] of new URLSearchParams(search)) {
    const normalizedKey = key.toLowerCase()
    if (isSafeTelemetryAttributionKey(normalizedKey) && isSafeTelemetryAttributionValue(value)) {
      safeParams.append(normalizedKey, value)
    }
  }

  const value = safeParams.toString()
  return value ? `?${value}` : ''
}

function isSafeTelemetryAttributionValue(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false
  if (/\bBearer\s+/i.test(value)) return false
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return false
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)) return false
  return !/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)
}

export function sanitizeTelemetryUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    url.username = ''
    url.password = ''
    url.search = sanitizeTelemetrySearch(url.search)
    return url.href
  } catch {
    return value.split(/[?#]/, 1)[0]
  }
}

export function getTelemetryCookieOptions() {
  if (typeof window === 'undefined') return 'path=/; SameSite=Lax'
  if (!IS_PROD) return 'path=/; SameSite=Lax'

  const hostname = window.location.hostname
  const isSupabaseCom = hostname === 'supabase.com' || hostname.endsWith('.supabase.com')
  return isSupabaseCom ? 'path=/; domain=supabase.com; SameSite=Lax' : 'path=/; SameSite=Lax'
}

// Parse session_id from PostHog cookie since SDK doesn't expose session ID
// (needed to correlate client and server events)
function getPostHogSessionId(): string | null {
  if (!isBrowser) return null

  try {
    // Parse PostHog cookie to extract session ID
    const phCookies = document.cookie.split(';').find((cookie) => cookie.trim().startsWith('ph_'))

    if (phCookies) {
      const cookieValue = decodeURIComponent(phCookies.split('=')[1])
      const phData = JSON.parse(cookieValue)
      if (phData.$sesid && Array.isArray(phData.$sesid) && phData.$sesid[1]) {
        return phData.$sesid[1]
      }
    }
  } catch (error) {
    console.warn('Could not extract PostHog session ID:', error)
  }

  return null
}

export function getSharedTelemetryData(pathname?: string) {
  const sessionId = getPostHogSessionId()
  const pageUrl = (() => {
    if (!isBrowser) return ''

    try {
      return sanitizeTelemetryUrl(window.location.href)
    } catch {
      return sanitizeTelemetryUrl(window.location.href)
    }
  })()

  return {
    page_url: pageUrl,
    page_title: isBrowser ? document?.title : '',
    pathname: pathname ? pathname : isBrowser ? window.location.pathname : '',
    session_id: sessionId,
    ph: {
      referrer: isBrowser ? sanitizeTelemetryUrl(document?.referrer) : '',
      language: navigator.language ?? 'en-US',
      user_agent: navigator.userAgent,
      search: isBrowser ? sanitizeTelemetrySearch(window.location.search) : '',
      viewport_height: isBrowser ? window.innerHeight : 0,
      viewport_width: isBrowser ? window.innerWidth : 0,
    },
  }
}
