import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { frameworkCommand, runFramework } from './framework-launcher.js'

function fakeChild() {
  const child = new EventEmitter()
  child.killed = false
  child.exitCode = null
  child.signalCode = null
  return child
}

test('builds cross-platform Next and Vite arguments from environment values', () => {
  assert.deepEqual(frameworkCommand('dev:tanstack', { STUDIO_PORT: '8999' }).args, [
    'dev',
    '--port',
    '8999',
  ])
  assert.deepEqual(frameworkCommand('dev:next', { STUDIO_PORT: '9000' }).args, [
    'dev',
    '-p',
    '9000',
  ])
  assert.deepEqual(frameworkCommand('preview', { MODE: 'staging', STUDIO_PORT: '9001' }).args, [
    'preview',
    '--mode',
    'staging',
    '--port',
    '9001',
  ])
  assert.deepEqual(frameworkCommand('start:next', { STUDIO_PORT: '9002' }).args, [
    'start',
    '-p',
    '9002',
  ])
  assert.deepEqual(frameworkCommand('build:tanstack', {}).args, [
    'build',
    '--mode',
    'production',
  ])
})

test('runs the TanStack smoke test only after a successful build', () => {
  const calls = []
  const children = []
  runFramework('build:tanstack', {
    env: { MODE: 'test' },
    registerSignals: false,
    spawnImpl(command, args, options) {
      calls.push({ command, args, options })
      const child = fakeChild()
      children.push(child)
      return child
    },
  })
  assert.equal(calls.length, 1)
  children[0].emit('exit', 0, null)
  assert.equal(calls.length, 2)
  assert.match(calls[1].args[0], /smoke-server\.mjs$/)
  children[1].emit('exit', 0, null)
  process.exitCode = undefined
})

test('terminates the active framework child through the process-tree helper', () => {
  const child = fakeChild()
  const handlers = new Map()
  const originalOn = process.on
  process.on = (signal, handler) => {
    handlers.set(signal, handler)
    return process
  }
  try {
    const terminated = []
    runFramework('dev:tanstack', {
      spawnImpl: () => child,
      terminateImpl(active, signal) {
        terminated.push({ active, signal })
      },
    })
    handlers.get('SIGTERM')()
    assert.deepEqual(terminated, [{ active: child, signal: 'SIGTERM' }])
  } finally {
    process.on = originalOn
  }
})

test('rejects unknown launcher targets', () => {
  assert.throws(() => frameworkCommand('unknown'), /unknown target/)
})
