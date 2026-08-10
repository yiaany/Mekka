import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEnvFiles } from './lib/env.js'

// This script cleans up the Turbopack cache by removing files that haven't been modified in the last 3 days. This is to
// prevent the cache from growing indefinitely and consuming too much RAM.
const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fileEnv = readEnvFiles(studioRoot, ['.env', '.env.local'])
const studioFramework = process.env.STUDIO_FRAMEWORK ?? fileEnv.STUDIO_FRAMEWORK
const dir = path.join(studioRoot, '.next/dev/cache/turbopack')
const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days in milliseconds

function clean(d) {
  if (!existsSync(d)) return
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name)
    if (entry.isDirectory()) {
      clean(p)
    } else if (statSync(p).mtimeMs < cutoff) {
      rmSync(p)
    }
  }
}

// `predev` also runs before the default TanStack/Vite dispatcher path. Avoid
// synchronously walking an unrelated Turbopack cache in that case.
if (studioFramework === 'next') clean(dir)
