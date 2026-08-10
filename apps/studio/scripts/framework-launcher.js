#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { terminateProcessTree } from './process-tree.js'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function frameworkCommand(target, env = process.env, platform = process.platform) {
  const executableName = (name) => (platform === 'win32' ? `${name}.exe` : name)
  const binary = (name) => {
    const local = path.join(studioRoot, 'node_modules', '.bin', executableName(name))
    const root = path.join(studioRoot, '..', '..', 'node_modules', '.bin', executableName(name))
    return existsSync(local) ? local : root
  }
  const mode = env.MODE || 'production'
  const port = env.STUDIO_PORT || '8082'

  switch (target) {
    case 'dev:tanstack':
      return { command: binary('vite'), args: ['dev', '--port', port] }
    case 'preview':
      return { command: binary('vite'), args: ['preview', '--mode', mode, '--port', port] }
    case 'dev:next':
      return { command: binary('next'), args: ['dev', '-p', port] }
    case 'start:next':
      return { command: binary('next'), args: ['start', '-p', port] }
    case 'build:tanstack':
      return { command: binary('vite'), args: ['build', '--mode', mode], smoke: true }
    default:
      throw new Error(`unknown target: ${target}`)
  }
}

export function runFramework(target, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const env = options.env ?? process.env
  const terminate = options.terminateImpl ?? terminateProcessTree
  const spec = frameworkCommand(target, env, options.platform ?? process.platform)
  let activeChild = null
  const child = spawnImpl(spec.command, spec.args, {
    cwd: studioRoot,
    env,
    stdio: 'inherit',
    shell: false,
  })
  activeChild = child

  if (options.registerSignals !== false) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
      process.on(signal, () => terminate(activeChild, signal))
    }
  }

  child.on('error', (error) => {
    console.error(`framework-launcher.js: failed to start ${target}:`, error)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else if (code !== 0 || !spec.smoke) process.exitCode = code ?? 1
    else {
      const smoke = spawnImpl(process.execPath, [path.join(studioRoot, 'scripts/smoke-server.mjs')], {
        cwd: studioRoot,
        env,
        stdio: 'inherit',
        shell: false,
      })
      activeChild = smoke
      smoke.on('error', (error) => {
        console.error('framework-launcher.js: failed to start build smoke test:', error)
        process.exitCode = 1
      })
      smoke.on('exit', (smokeCode, smokeSignal) => {
        if (smokeSignal) process.kill(process.pid, smokeSignal)
        else process.exitCode = smokeCode ?? 1
      })
    }
  })
  return child
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    runFramework(process.argv[2])
  } catch (error) {
    console.error(`framework-launcher.js: ${error.message}`)
    process.exitCode = 2
  }
}
