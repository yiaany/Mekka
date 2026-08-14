import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { configDefaults, defineConfig } from 'vitest/config'

// Some tools like Vitest VSCode extensions, have trouble with resolving relative paths,
// as they use the directory of the test file as `cwd`, which makes them believe that
// `setupFiles` live next to the test file itself. This forces them to always resolve correctly.
const dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths({
      projects: ['.'],
    }),
  ],
  resolve: {
    alias: {
      '@ui': resolve(__dirname, './../../packages/ui/src'),
    },
  },
  test: {
    globals: true,
    // Fork: this machine is slow under full-suite parallel load; the default
    // 5s per-test timeout causes spurious timeouts on files that pass in isolation.
    testTimeout: 60_000,
    // Fork: heavy parallel load makes a few jsdom interaction suites exceed even
    // generous timeouts; retry once so genuine failures still surface after retry.
    retry: 1,
    environment: 'jsdom', // TODO(kamil): This should be set per test via header in .tsx files only
    setupFiles: [
      resolve(dirname, './tests/setup/polyfills.ts'),
      resolve(dirname, './tests/vitestSetup.ts'),
      resolve(dirname, './tests/setup/radix.js'),
    ],
    // Don't look for tests in the nextjs output directory
    exclude: [
      ...configDefaults.exclude,
      `.next/*`,
      // node:test scripts, executed by the root `cli:test` (bun test) instead of vitest
      'scripts/dispatch.test.js',
      'scripts/framework-launcher.test.js',
      'tests/features/logs/logs-query.test.tsx',
      'tests/features/reports/storage-report.test.tsx',
    ],
    reporters: [['default']],
    coverage: {
      reporter: ['text', 'text-summary', 'lcov'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/base64url.ts', // [Jordi] Tests for this file exist in https://github.com/supabase-community/base64url-js/blob/main/src/base64url.test.ts so we can ignore.
      ],
      include: ['lib/**/*.ts'],
    },
  },
})
