#!/usr/bin/env node
// Dispatch a top-level npm script (dev/build/start) to either the next- or
// tanstack-flavoured variant based on STUDIO_FRAMEWORK. We parse the env files
// (via the shared scripts/lib/env.js parser) and pull out only the dispatch
// settings we must coordinate across children. We deliberately don't load the
// whole file into the child's process.env, because scripts/serve.js / vite do
// their own .env loading and would otherwise refuse to override dispatcher-set
// values, including NEXT_PUBLIC_IS_PLATFORM which the e2e `.env.test` needs to
// flip to `false`.
//
// Usage: node scripts/dispatch.js <target>
//   target ∈ { dev, build, start }
//
// Resolves to `bun run <target>:<framework>` where framework is `tanstack`
// by default. STUDIO_FRAMEWORK=next remains an explicit rollback path while
// the legacy tree is being retired.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readEnvFiles } from './lib/env.js'
import { terminateProcessTree } from './process-tree.js'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Shell env wins, then `.env.local`, then `.env` — the same precedence
// scripts/serve.js and vite use, so STUDIO_FRAMEWORK set in either file is
// picked up (not just `.env.local`).
export function resolveBunExecutable(env = process.env, platform = process.platform) {
  if (env.MEKKA_BUN_EXECUTABLE) return path.resolve(env.MEKKA_BUN_EXECUTABLE)

  const executable = platform === 'win32' ? 'bun.exe' : 'bun'
  const candidates = [
    env.BUN_INSTALL ? path.join(env.BUN_INSTALL, 'bin', executable) : null,
    path.join(homedir(), '.bun', 'bin', executable),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? executable
}

export function resolveDispatch(
  target,
  env = process.env,
  fileEnv = readEnvFiles(studioRoot, ['.env', '.env.local'])
) {
  if (!target || !['dev', 'build', 'start'].includes(target)) {
    throw new Error('missing or invalid target (expected one of: dev, build, start)')
  }
  const studioFramework = env.STUDIO_FRAMEWORK ?? fileEnv.STUDIO_FRAMEWORK
  const framework = studioFramework === 'next' ? 'next' : 'tanstack'
  const studioPort = resolvePort(env.STUDIO_PORT ?? fileEnv.STUDIO_PORT ?? '8082', 'STUDIO_PORT')
  const backendPort = resolvePort(
    env.SQLITE_META_PORT ?? fileEnv.SQLITE_META_PORT ?? '3001',
    'SQLITE_META_PORT'
  )
  return {
    packageManager: resolveBunExecutable(env),
    script: `${target}:${framework}`,
    startBackend: target === 'dev',
    studioPort,
    backendPort,
  }
}

function resolvePort(value, name) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
  return String(port)
}

export function resolveInternalProxyToken(
  env = process.env,
  fileEnv = readEnvFiles(studioRoot, ['.env', '.env.local'])
) {
  const configured = env.MEKKA_INTERNAL_PROXY_TOKEN ?? fileEnv.MEKKA_INTERNAL_PROXY_TOKEN
  if (configured === undefined) return randomBytes(32).toString('base64url')
  if (configured.length < 24 || !/^[\x21-\x7e]+$/.test(configured)) {
    throw new Error(
      'MEKKA_INTERNAL_PROXY_TOKEN must contain at least 24 visible ASCII characters without whitespace'
    )
  }
  return configured
}

async function requestWithTimeout(url, options) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = options.setTimeoutImpl(abort, options.requestTimeoutMs)
  try {
    return await options.fetchImpl(url, { signal: controller.signal })
  } finally {
    options.clearTimeoutImpl(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function waitForHttp(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
  const attempts = options.attempts ?? 120
  const intervalMs = options.intervalMs ?? 250
  const requestTimeoutMs = options.requestTimeoutMs ?? 1_000
  const acceptResponse = options.acceptResponse ?? (() => true)

  for (let attempt = 0; attempt < attempts && !options.signal?.aborted; attempt += 1) {
    try {
      const response = await requestWithTimeout(url, {
        fetchImpl,
        signal: options.signal,
        requestTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      })
      if (acceptResponse(response)) return true
    } catch {
      if (options.signal?.aborted) return false
    }
    if (attempt + 1 < attempts && !options.signal?.aborted) await sleepImpl(intervalMs)
  }
  return false
}

// Use async `spawn` rather than `spawnSync` — long-running dev servers
// (vite dev / next dev) wedge under `spawnSync` because Node holds the
// event loop and stdin doesn't flow through cleanly. The dev server says
// "ready" then exits ~1s later. `spawn` + manual forwarding keeps the
// child interactive and lets the parent exit cleanly when the child does.
export function runDispatch(target, options = {}) {
  const env = options.env ?? process.env
  const spawnImpl = options.spawnImpl ?? spawn
  const fileEnv = options.fileEnv ?? readEnvFiles(studioRoot, ['.env', '.env.local'])
  const { packageManager, script, startBackend, studioPort, backendPort } = resolveDispatch(
    target,
    env,
    fileEnv
  )
  const internalProxyToken = startBackend ? resolveInternalProxyToken(env, fileEnv) : undefined
  const backendUrl = `http://127.0.0.1:${backendPort}`
  const studioUrl = `http://127.0.0.1:${studioPort}`
  const studioHealthUrl = `${studioUrl}/api/platform/sqlite-meta/local/schema/health`
  const log = options.logImpl ?? console.log
  const error = options.errorImpl ?? console.error
  const terminate = options.terminateImpl ?? terminateProcessTree
  const readinessAbort = new AbortController()
  let child = null
  let readiness = null
  let stopping = false
  const localBackend = startBackend
    ? spawnImpl(packageManager, ['--watch', '../sqlite-meta/src/local.ts'], {
        cwd: studioRoot,
        stdio: 'inherit',
        env: {
          ...env,
          AUTH_PUBLIC_ORIGIN: env.AUTH_PUBLIC_ORIGIN ?? fileEnv.AUTH_PUBLIC_ORIGIN ?? studioUrl,
          MEKKA_LOCAL_DEV: '1',
          MEKKA_INTERNAL_PROXY_TOKEN: internalProxyToken,
          SQLITE_META_HOST: '127.0.0.1',
          SQLITE_META_PORT: backendPort,
        },
      })
    : null

  const monitorReadiness = () => {
    const monitorOptions = {
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl,
      attempts: options.readinessAttempts,
      intervalMs: options.readinessIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      signal: readinessAbort.signal,
    }
    const backendReady = waitForHttp(backendUrl, monitorOptions).then((ready) => {
      if (ready) log('Backend ready')
      return ready
    })
    const studioReady = waitForHttp(studioHealthUrl, {
      ...monitorOptions,
      acceptResponse: (response) => response.ok,
    })
    return Promise.all([backendReady, studioReady]).then(([isBackendReady, isStudioReady]) => {
      if (isBackendReady && isStudioReady && !readinessAbort.signal.aborted) {
        log(`Mekka ready at ${studioUrl}`)
        return true
      }
      if (!readinessAbort.signal.aborted) {
        error('dispatch.js: timed out waiting for local development services')
        stopping = true
        process.exitCode = 1
        terminate(child)
        terminate(localBackend)
      }
      return false
    })
  }

  const startStudio = () => {
    log('Studio building')
    child = spawnImpl(packageManager, ['run', script], {
      stdio: 'inherit',
      env:
        localBackend === null
          ? env
          : {
              ...env,
              AUTH_PUBLIC_ORIGIN:
                env.AUTH_PUBLIC_ORIGIN ?? fileEnv.AUTH_PUBLIC_ORIGIN ?? studioUrl,
              MEKKA_LOCAL_DEV: '1',
              MEKKA_INTERNAL_PROXY_TOKEN: internalProxyToken,
              SQLITE_META_PORT: backendPort,
              STUDIO_BACKEND_API_URL: backendUrl,
              STUDIO_PORT: studioPort,
            },
    })
    readiness = startBackend ? monitorReadiness() : null
    child.on('error', (err) => {
      error('dispatch.js: failed to spawn child:', err)
      stopping = true
      readinessAbort.abort()
      terminate(localBackend)
      process.exitCode = 1
    })
    child.on('exit', (code, signal) => {
      const wasStopping = stopping
      stopping = true
      readinessAbort.abort()
      terminate(localBackend)
      if (signal && !wasStopping) process.kill(process.pid, signal)
      else if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = code ?? 1
    })
  }

  if (localBackend === null) startStudio()
  else localBackend.once('spawn', startStudio)

  const forwardSignal = (signal) => {
    stopping = true
    readinessAbort.abort()
    terminate(child, signal)
    terminate(localBackend, signal)
  }
  if (options.registerSignals !== false) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      process.on(signal, () => forwardSignal(signal))
    }
  }

  localBackend?.on('error', (err) => {
    error('dispatch.js: failed to spawn sqlite-meta local backend:', err)
    stopping = true
    readinessAbort.abort()
    terminate(child)
    process.exitCode = 1
  })
  localBackend?.on('exit', (code, signal) => {
    if (stopping) return
    stopping = true
    readinessAbort.abort()
    terminate(child)
    if (process.exitCode === undefined || process.exitCode === 0) {
      error('dispatch.js: sqlite-meta local backend exited unexpectedly', { code, signal })
      process.exitCode = code || 1
    }
  })

  return {
    get child() {
      return child
    },
    get readiness() {
      return readiness
    },
    localBackend,
    packageManager,
    script,
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    runDispatch(process.argv[2])
  } catch (error) {
    console.error(`dispatch.js: ${error.message}`)
    process.exitCode = 2
  }
}
