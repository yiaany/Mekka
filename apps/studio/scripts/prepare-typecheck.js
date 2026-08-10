#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { frameworkCommand } from './framework-launcher.js'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(studioRoot, '../..')

export function prepareTypecheck({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  run(spawnSyncImpl, process.execPath, [path.join(workspaceRoot, 'scripts/ensure-core-build.mjs')], {
    cwd: workspaceRoot,
    env,
  })

  const typegen = frameworkCommand('typegen', env)
  run(spawnSyncImpl, typegen.command, typegen.args, { cwd: studioRoot, env })
}

function run(spawnSyncImpl, command, args, options) {
  const result = spawnSyncImpl(command, args, {
    ...options,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  prepareTypecheck()
} catch (error) {
  console.error(`Studio typecheck preparation failed: ${error.message}`)
  process.exitCode = 1
}
