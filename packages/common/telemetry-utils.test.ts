import { describe, expect, it } from 'vitest'

import { sanitizeTelemetrySearch, sanitizeTelemetryUrl } from './telemetry-utils'

describe('telemetry URL sanitization', () => {
  it('keeps only safe attribution query parameters', () => {
    const url = sanitizeTelemetryUrl(
      'https://user:password@supabase.com/dashboard?utm_source=google&gclid=click-id&token=secret&code=oauth-code&email=member%40example.com&api_key=key&signature=sig#access_token=fragment'
    )

    expect(url).toBe('https://supabase.com/dashboard?utm_source=google&gclid=click-id')
  })

  it('normalizes allowed keys and drops every non-attribution query parameter', () => {
    expect(
      sanitizeTelemetrySearch('?UTM_CAMPAIGN=launch&fbclid=click&key=secret&custom=value')
    ).toBe('?utm_campaign=launch&fbclid=click')
  })

  it('removes query and fragments from malformed URLs', () => {
    expect(sanitizeTelemetryUrl('/dashboard?token=secret#code=secret')).toBe('/dashboard')
  })

  it('drops PII and credential-shaped values even under allowlisted attribution keys', () => {
    expect(
      sanitizeTelemetrySearch(
        '?utm_source=Bearer%20secret&utm_campaign=member%40example.com&gclid=safe-click'
      )
    ).toBe('?gclid=safe-click')
  })
})
