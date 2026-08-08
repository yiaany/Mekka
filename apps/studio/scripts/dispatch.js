#!/usr/bin/env node
// Dispatch a top-level npm script (dev/build/start) to either the next- or
// tanstack-flavoured variant based on STUDIO_FRAMEWORK. We parse the env files
// (via the shared scripts/lib/env.js parser) and pull out only
// STUDIO_FRAMEWORK — we deliberately don't load the whole file into the
// child's process.env, because scripts/serve.js / vite do their own .env
// loading and would otherwise refuse to override the dispatcher-set values,
// including NEXT_PUBLIC_IS_PLATFORM which the e2e `.env.test` needs to flip to
// `false`.
//
// Usage: node scripts/dispatch.js <target>
//   target ∈ { dev, build, start }
//
// Resolves to `bun run <target>:<framework>` where framework is `tanstack`
// by default. STUDIO_FRAMEWORK=next remains an explicit rollback path while
// the legacy tree is being retired.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readEnvFiles } from './lib/env.js'

const target = process.argv[2]
if (!target) {
  console.error('dispatch.js: missing target (expected one of: dev, build, start)')
  process.exit(2)
}

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Shell env wins, then `.env.local`, then `.env` — the same precedence
// scripts/serve.js and vite use, so STUDIO_FRAMEWORK set in either file is
// picked up (not just `.env.local`).
const fileEnv = readEnvFiles(studioRoot, ['.env', '.env.local'])
const studioFramework = process.env.STUDIO_FRAMEWORK ?? fileEnv.STUDIO_FRAMEWORK
const framework = studioFramework === 'next' ? 'next' : 'tanstack'
const script = `${target}:${framework}`

// Use async `spawn` rather than `spawnSync` — long-running dev servers
// (vite dev / next dev) wedge under `spawnSync` because Node holds the
// event loop and stdin doesn't flow through cleanly. The dev server says
// "ready" then exits ~1s later. `spawn` + manual forwarding keeps the
// child interactive and lets the parent exit cleanly when the child does.
const packageManager = process.platform === 'win32' ? 'bun.exe' : 'bun'
const localBackend =
  target === 'dev' && studioFramework !== 'next'
    ? spawn(packageManager, ['--watch', '../sqlite-meta/src/local.ts'], {
        cwd: studioRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          AUTH_PUBLIC_ORIGIN: 'http://127.0.0.1:8082',
          MEKKA_LOCAL_DEV: '1',
          SQLITE_META_PORT: '3001',
        },
      })
    : null
const child = spawn(packageManager, ['run', script], {
  stdio: 'inherit',
  env:
    localBackend === null
      ? process.env
      : { ...process.env, STUDIO_BACKEND_API_URL: 'http://127.0.0.1:3001' },
})

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal)
  if (localBackend !== null && !localBackend.killed) localBackend.kill(signal)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => forwardSignal(signal))
}

child.on('exit', (code, signal) => {
  if (localBackend !== null && !localBackend.killed) localBackend.kill()
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})

child.on('error', (err) => {
  console.error('dispatch.js: failed to spawn child:', err)
  process.exit(1)
})

localBackend?.on('error', (err) => {
  console.error('dispatch.js: failed to spawn sqlite-meta local backend:', err)
  if (!child.killed) child.kill()
  process.exit(1)
})
