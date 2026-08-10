import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from 'vite'

import { studioRouterGeneratorConfig } from './vite.config'

describe('studio router generator config', () => {
  it('avoids route-test discovery', () => {
    expect('mcp.test.ts').toMatch(new RegExp(studioRouterGeneratorConfig.routeFileIgnorePattern))
    expect('mcp.spec.tsx').toMatch(new RegExp(studioRouterGeneratorConfig.routeFileIgnorePattern))
    expect('mcp.ts').not.toMatch(new RegExp(studioRouterGeneratorConfig.routeFileIgnorePattern))
  })

  it(
    'keeps Start route generation and code splitting enabled',
    async () => {
      const config = await resolveConfig(
        { configFile: path.resolve(import.meta.dirname, 'vite.config.ts'), mode: 'development' },
        'serve'
      )

      expect(config.plugins.some(({ name }) => name === 'tanstack:router-generator')).toBe(true)
      expect(
        config.plugins.some(({ name }) => name.startsWith('tanstack-router:code-splitter'))
      ).toBe(true)
    },
    20_000
  )
})
