import { afterEach, describe, expect, test, vi } from 'vitest'

import { vercelRoutes } from './vercel-config'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Vercel config helpers', () => {
  test('preserves the rewrite and cache-control output used by Studio', () => {
    expect(vercelRoutes.rewrite('/api/(.*)', '/api/server')).toEqual({
      source: '/api/(.*)',
      destination: '/api/server',
    })
    expect(vercelRoutes.cacheControl('/api/(.*)', { private: true, noStore: true })).toEqual({
      source: '/api/(.*)',
      headers: [{ key: 'Cache-Control', value: 'private, no-store' }],
    })
    expect(
      vercelRoutes.cacheControl('/assets/(.*)', {
        public: true,
        maxAge: '1year',
        immutable: true,
      })
    ).toEqual({
      source: '/assets/(.*)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31557600, immutable' }],
    })
  })

  test('exports the external libpg-query WASM without assuming a package manager layout', async () => {
    vi.stubEnv('STUDIO_FRAMEWORK', 'tanstack')

    const { config } = await import('./vercel')
    const includeFiles = config.functions?.['api/server.js']?.includeFiles

    expect(includeFiles).toContain(
      '../../node_modules/**/libpg-query/wasm/libpg-query.wasm'
    )
    expect(includeFiles).not.toContain('.pnpm')
  })
})
