#!/usr/bin/env bun
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = path.resolve(studioRoot, '../..')
const backendEntry =
  process.env.MEKKA_SQLITE_META_ENTRY ?? path.join(workspaceRoot, 'apps/sqlite-meta/src/index.ts')

await import(pathToFileURL(backendEntry).href)
await import(pathToFileURL(path.join(studioRoot, 'scripts/serve.js')).href)
