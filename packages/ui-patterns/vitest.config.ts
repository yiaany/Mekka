import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Radix/jsdom interaction tests share browser primitives. Keep two workers
    // in every environment instead of serializing the suite or saturating the machine.
    maxWorkers: 2,
    retry: process.env.CI === 'true' ? 1 : 0,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    reporters: ['default'],
    coverage: {
      reporter: ['text', 'json', 'html'],
    },
  },
})
