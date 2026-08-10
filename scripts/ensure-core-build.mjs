#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

export function ensureCoreBuild({
  env = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (env.MEKKA_CORE_BUILT === "1") return;

  const bunExecutable = env.MEKKA_BUN_EXECUTABLE ?? (platform === "win32" ? "bun.exe" : "bun");
  console.log("Checking Mekka core outputs...");
  const result = spawnSyncImpl(bunExecutable, ["run", "build:core"], {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Mekka core build failed with status ${result.status ?? "unknown"}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    ensureCoreBuild();
  } catch (error) {
    console.error(`Mekka could not prepare workspace packages: ${error.message}`);
    process.exitCode = 1;
  }
}
