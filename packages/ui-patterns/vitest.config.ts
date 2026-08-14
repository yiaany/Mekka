import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Radix/jsdom interaction tests share browser primitives. Bound CI to two
    // workers instead of serializing the suite or saturating the machine.
    maxWorkers: process.env.CI === 'true' ? 2 : undefined,
    retry: process.env.CI === 'true' ? 1 : 0,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    reporters: ['default', 'json'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
})
