import { describe, expect, it } from 'vitest'

import { redactAuthDebugValue } from './gotrue-redaction'

describe('auth debug redaction', () => {
  it('recursively removes secrets and PII without mutating the source', () => {
    const source = {
      event: 'SIGNED_IN',
      nested: {
        access_token: 'access-secret',
        client_secret: 'client-secret',
        profile: { email: 'member@example.com', phone: '+15555550123' },
        safe: 'kept',
      },
      sessions: [{ refreshToken: 'refresh-secret', signature: 'signature-secret' }],
    }

    expect(redactAuthDebugValue(source)).toEqual({
      event: 'SIGNED_IN',
      nested: {
        access_token: '[REDACTED]',
        client_secret: '[REDACTED]',
        profile: { email: '[REDACTED]', phone: '[REDACTED]' },
        safe: 'kept',
      },
      sessions: [{ refreshToken: '[REDACTED]', signature: '[REDACTED]' }],
    })
    expect(source.nested.access_token).toBe('access-secret')
  })

  it('redacts emails, bearer credentials, and JWTs in string values', () => {
    expect(
      redactAuthDebugValue(
        'member@example.com Bearer secret-token aaa.bbb.ccc https://example.com/?code=secret'
      )
    ).toBe('[REDACTED] Bearer [REDACTED] [REDACTED] https://example.com/?code=[REDACTED]')
  })

  it('redacts opaque credentials embedded in diagnostic strings', () => {
    expect(
      redactAuthDebugValue(
        'refresh_token=opaque-refresh access_token: opaque-access client_secret=opaque-client'
      )
    ).toBe('refresh_token=[REDACTED] access_token:[REDACTED] client_secret=[REDACTED]')
  })
})
