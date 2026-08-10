import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [react(), tsconfigPaths({ projects: ['.'] })],
  resolve: {
    alias: {
      '@ui': resolve(dirname, '../../packages/ui/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/fork/**/*.{test,spec}.{ts,tsx}'],
    reporters: [['default']],
  },
})
