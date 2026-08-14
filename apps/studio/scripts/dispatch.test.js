import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'

import {
  resolveBunExecutable,
  resolveDispatch,
  resolveInternalProxyToken,
  runDispatch,
  waitForHttp,
} from './dispatch.js'
import { terminateProcessTree } from './process-tree.js'

function fakeChild() {
  const child = new EventEmitter()
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.killed = true
    return true
  }
  return child
}

test('terminates only the spawned Windows process tree by PID', () => {
  const child = fakeChild()
  child.pid = 4321
  let invocation
  assert.equal(
    terminateProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      spawnSyncImpl(command, args, options) {
        invocation = { command, args, options }
        return { status: 0 }
      },
    }),
    true
  )
  assert.deepEqual(invocation.args, ['/PID', '4321', '/T', '/F'])
  assert.equal(invocation.options.shell, false)
  assert.equal(child.killed, false)
})

test('does not target a PID after its spawned child has exited', () => {
  const child = fakeChild()
  child.pid = 4321
  child.exitCode = 0
  assert.equal(
    terminateProcessTree(child, 'SIGTERM', {
      platform: 'win32',
      spawnSyncImpl() {
        assert.fail('an exited child PID must not be passed to taskkill')
      },
    }),
    false
  )
})

test('uses the absolute Bun executable passed by the CLI', () => {
  const executable = path.resolve('temporary bun location', 'bun.exe')
  assert.equal(resolveBunExecutable({ MEKKA_BUN_EXECUTABLE: executable }, 'win32'), executable)
  assert.equal(resolveDispatch('build', { MEKKA_BUN_EXECUTABLE: executable }).packageManager, executable)
})

test('defaults to the TanStack scripts and keeps Next and ports configurable', () => {
  assert.equal(resolveDispatch('start', {}).script, 'start:tanstack')
  assert.equal(resolveDispatch('dev', {}).script, 'dev:stable')
  const next = resolveDispatch('dev', {
    STUDIO_FRAMEWORK: 'next',
    STUDIO_PORT: '9000',
    SQLITE_META_PORT: '4001',
  })
  assert.equal(next.script, 'dev:next')
  assert.equal(next.startBackend, true)
  assert.equal(next.studioPort, '9000')
  assert.equal(next.backendPort, '4001')
  assert.throws(() => resolveDispatch('invalid', {}), /expected one of/)
  assert.throws(() => resolveDispatch('dev', { STUDIO_PORT: 'nope' }), /STUDIO_PORT/)
})

test('starts the combined low-memory runtime and reports truthful readiness milestones', async () => {
  const calls = []
  const children = []
  const requests = []
  const logs = []
  const result = runDispatch('dev', {
    env: {
      MEKKA_BUN_EXECUTABLE: path.resolve('bun'),
      STUDIO_PORT: '9000',
      SQLITE_META_PORT: '4001',
    },
    fileEnv: {},
    registerSignals: false,
    logImpl: (message) => logs.push(message),
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      return { ok: url.includes('/api/platform/') }
    },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['run', 'dev:stable'])
  assert.equal(calls[0].options.env.STUDIO_BACKEND_API_URL, 'http://127.0.0.1:4001')
  assert.equal(calls[0].options.env.STUDIO_PORT, '9000')
  assert.equal(calls[0].options.env.SQLITE_META_PORT, '4001')
  assert.equal(calls[0].options.env.AUTH_PUBLIC_ORIGIN, 'http://127.0.0.1:9000')
  assert.equal(calls[0].options.env.MEKKA_LOCAL_DEV, '1')
  assert.match(calls[0].options.env.MEKKA_INTERNAL_PROXY_TOKEN, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(calls[0].options.stdio, 'inherit')
  assert.equal(await result.readiness, true)
  assert.deepEqual(logs, ['Studio building', 'Mekka ready at http://127.0.0.1:9000'])
  assert.deepEqual(
    requests.map(({ url }) => url).sort(),
    ['http://127.0.0.1:9000/api/platform/sqlite-meta/local/schema/health']
  )
  assert.ok(requests.every(({ options }) => Object.keys(options).join(',') === 'signal'))
  children[0].emit('exit', 0, null)
  assert.equal(process.exitCode, 0)
  process.exitCode = undefined
})

test('propagates AUTH_PUBLIC_ORIGIN from env files to the combined dev runtime', () => {
  const calls = []
  const children = []
  runDispatch('dev', {
    env: { MEKKA_BUN_EXECUTABLE: path.resolve('bun') },
    fileEnv: { AUTH_PUBLIC_ORIGIN: 'https://mekka.local.example' },
    registerSignals: false,
    logImpl: () => {},
    fetchImpl: async () => ({ ok: true }),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })
  assert.equal(calls[0].options.env.AUTH_PUBLIC_ORIGIN, 'https://mekka.local.example')
  children[0].emit('exit', 0, null)
  process.exitCode = undefined
})

test('covers Next dev dispatch with the same backend and full readiness checks', async () => {
  const calls = []
  const children = []
  const token = 'explicit-local-proxy-token-123456'
  const result = runDispatch('dev', {
    env: {
      MEKKA_BUN_EXECUTABLE: path.resolve('bun'),
      MEKKA_INTERNAL_PROXY_TOKEN: token,
      STUDIO_FRAMEWORK: 'next',
    },
    fileEnv: {},
    registerSignals: false,
    logImpl: () => {},
    fetchImpl: async () => ({ ok: true }),
    spawnImpl(command, args, options) {
      calls.push({ command, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  children[0].emit('spawn')
  assert.deepEqual(calls[1].args, ['run', 'dev:next'])
  assert.equal(calls[0].options.env.MEKKA_INTERNAL_PROXY_TOKEN, token)
  assert.equal(calls[1].options.env.MEKKA_INTERNAL_PROXY_TOKEN, token)
  assert.equal(await result.readiness, true)
  children[1].emit('exit', 0, null)
  children[0].emit('exit', 0, null)
  process.exitCode = undefined
})

test('bounds polling and aborts each request after the configured timeout', async () => {
  let requests = 0
  let timers = 0
  const ready = await waitForHttp('http://127.0.0.1:1', {
    attempts: 2,
    requestTimeoutMs: 10,
    sleepImpl: async () => {},
    setTimeoutImpl(callback) {
      timers += 1
      queueMicrotask(callback)
      return timers
    },
    clearTimeoutImpl() {},
    fetchImpl(_url, { signal }) {
      requests += 1
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  })
  assert.equal(ready, false)
  assert.equal(requests, 2)
  assert.equal(timers, 2)
})

test('waits for the backend before starting a long-lived Studio readiness probe', async () => {
  const children = []
  const requests = []
  let releaseBackend
  const backendResponse = new Promise((resolve) => {
    releaseBackend = resolve
  })
  const result = runDispatch('dev', {
    env: { MEKKA_BUN_EXECUTABLE: path.resolve('bun'), STUDIO_FRAMEWORK: 'next' },
    fileEnv: {},
    registerSignals: false,
    logImpl: () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options })
      if (url === 'http://127.0.0.1:3001') return backendResponse
      return { ok: true }
    },
    spawnImpl() {
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  children[0].emit('spawn')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(requests.map(({ url }) => url), ['http://127.0.0.1:3001'])
  releaseBackend({ ok: true })
  assert.equal(await result.readiness, true)
  assert.deepEqual(requests.map(({ url }) => url), [
    'http://127.0.0.1:3001',
    'http://127.0.0.1:8082/api/platform/sqlite-meta/local/schema/health',
  ])
  children[0].emit('exit', 0, null)
  process.exitCode = undefined
})

test('stops readiness polling when either dev child exits', async () => {
  const children = []
  const errors = []
  const result = runDispatch('dev', {
    env: { MEKKA_BUN_EXECUTABLE: path.resolve('bun') },
    fileEnv: {},
    registerSignals: false,
    logImpl: () => {},
    errorImpl: (...args) => errors.push(args),
    fetchImpl(_url, { signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    spawnImpl() {
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  children[0].emit('exit', 1, null)
  assert.equal(await result.readiness, false)
  assert.deepEqual(errors, [])
  process.exitCode = undefined
})

test('marks readiness timeout as failure and terminates both dev process trees', async () => {
  const children = []
  const terminated = []
  const result = runDispatch('dev', {
    env: { MEKKA_BUN_EXECUTABLE: path.resolve('bun') },
    fileEnv: {},
    registerSignals: false,
    logImpl: () => {},
    errorImpl: () => {},
    readinessAttempts: 1,
    fetchImpl: async () => {
      throw new Error('not ready')
    },
    terminateImpl(child) {
      if (child) terminated.push(child)
      return true
    },
    spawnImpl() {
      const child = fakeChild()
      children.push(child)
      return child
    },
  })

  assert.equal(await result.readiness, false)
  assert.equal(process.exitCode, 1)
  assert.deepEqual(new Set(terminated), new Set(children))
  process.exitCode = undefined
})

test('preserves an env-file internal proxy token unless the shell overrides it', () => {
  const fileToken = 'env-file-local-proxy-token-123456'
  const shellToken = 'shell-local-proxy-token-12345678'
  assert.equal(resolveInternalProxyToken({}, { MEKKA_INTERNAL_PROXY_TOKEN: fileToken }), fileToken)
  assert.equal(
    resolveInternalProxyToken(
      { MEKKA_INTERNAL_PROXY_TOKEN: shellToken },
      { MEKKA_INTERNAL_PROXY_TOKEN: fileToken }
    ),
    shellToken
  )
})

test('rejects short or malformed explicit internal proxy tokens before spawning', () => {
  const message = /at least 24 visible ASCII characters without whitespace/
  assert.throws(
    () => resolveInternalProxyToken({ MEKKA_INTERNAL_PROXY_TOKEN: 'too-short' }, {}),
    message
  )
  assert.throws(
    () =>
      resolveInternalProxyToken(
        { MEKKA_INTERNAL_PROXY_TOKEN: 'long enough but contains spaces' },
        {}
      ),
    message
  )
  assert.throws(
    () =>
      runDispatch('dev', {
        env: { MEKKA_INTERNAL_PROXY_TOKEN: 'too-short' },
        fileEnv: {},
        registerSignals: false,
        spawnImpl() {
          assert.fail('invalid configuration must fail before spawning')
        },
      }),
    message
  )
})

test('does not start Studio when the Next local backend fails to spawn', () => {
  const backend = fakeChild()
  let calls = 0
  const originalError = console.error
  console.error = () => {}
  try {
    runDispatch('dev', {
        env: { MEKKA_BUN_EXECUTABLE: path.resolve('missing-bun'), STUDIO_FRAMEWORK: 'next' },
      fileEnv: {},
      registerSignals: false,
      spawnImpl() {
        calls += 1
        return backend
      },
    })
    backend.emit('error', new Error('ENOENT'))
    assert.equal(calls, 1)
    assert.equal(process.exitCode, 1)
  } finally {
    console.error = originalError
    process.exitCode = undefined
  }
})
