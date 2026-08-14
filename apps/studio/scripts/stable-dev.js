#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { terminateProcessTree } from './process-tree.js'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bunExecutable = process.env.MEKKA_BUN_EXECUTABLE ?? (process.platform === 'win32' ? 'bun.exe' : 'bun')
let activeChild
let stopping = false

function spawnChild(command, args, env = process.env) {
  activeChild = spawn(command, args, {
    cwd: studioRoot,
    env,
    stdio: 'inherit',
    shell: false,
  })
  activeChild.on('error', (error) => {
    console.error('[stable-dev] child failed:', error)
    process.exitCode = 1
  })
  return activeChild
}

function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  terminateProcessTree(activeChild, signal)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(signal, () => stop(signal))
}

console.log('Building the Studio SPA for the low-memory development runtime')
const build = spawnChild(bunExecutable, ['run', 'build:tanstack'])
build.on('exit', (code, signal) => {
  if (stopping) return
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  if (code !== 0) {
    process.exitCode = code ?? 1
    return
  }

  console.log('Starting the low-memory Studio runtime')
  const server = spawnChild(
    bunExecutable,
    ['--smol', path.join(studioRoot, 'scripts/local-runtime.js')],
    {
      ...process.env,
      PORT: process.env.STUDIO_PORT ?? process.env.PORT ?? '8082',
      STUDIO_BACKEND_API_URL:
        process.env.STUDIO_BACKEND_API_URL ?? `http://127.0.0.1:${process.env.SQLITE_META_PORT ?? '3001'}`,
      SQLITE_META_HOST: process.env.SQLITE_META_HOST ?? '127.0.0.1',
      SQLITE_META_PORT: process.env.SQLITE_META_PORT ?? '3001',
      MEKKA_LOCAL_DEV: '1',
    }
  )
  server.on('exit', (serverCode, serverSignal) => {
    if (serverSignal && !stopping) process.kill(process.pid, serverSignal)
    else process.exitCode = serverCode ?? 1
  })
})
