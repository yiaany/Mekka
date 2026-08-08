const REDACTED = '[REDACTED]'
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'address',
  'anonkey',
  'apikey',
  'authorization',
  'code',
  'cookie',
  'email',
  'identity',
  'identityid',
  'key',
  'metadata',
  'name',
  'otp',
  'password',
  'phone',
  'providertoken',
  'refreshtoken',
  'secret',
  'servicekey',
  'session',
  'sessionid',
  'signature',
  'token',
  'user',
  'userid',
])

function redactString(value: string): string {
  return value
    .replace(
      /([?&][^=&#\s]*(?:token|code|email|key|signature|password|secret)[^=&#\s]*=)[^&#\s]*/gi,
      `$1${REDACTED}`
    )
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b((?:access|refresh|provider|session|id)?_?token|client_?secret|api_?key|password|signature)\s*([=:])\s*([^\s,;&]+)/gi,
      `$1$2${REDACTED}`
    )
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function isSensitiveKey(key: string): boolean {
  const normalizedKey = normalizeKey(key)
  return (
    SENSITIVE_KEYS.has(normalizedKey) ||
    /(?:token|secret|password|signature|cookie|email|phone|address|otp|key)$/.test(normalizedKey)
  )
}

export function redactAuthDebugValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return REDACTED
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactAuthDebugValue(item, seen))
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    }
  }

  try {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? REDACTED : redactAuthDebugValue(item, seen),
      ])
    )
  } catch {
    return REDACTED
  }
}
