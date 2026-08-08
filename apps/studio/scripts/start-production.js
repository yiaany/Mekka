#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(studioRoot, "../..");
const internalProxyToken =
  process.env.MEKKA_INTERNAL_PROXY_TOKEN ?? randomBytes(32).toString("base64url");
const accessToken = process.env.MEKKA_STUDIO_ACCESS_TOKEN ?? "";
const port = process.env.PORT ?? "8082";
const environment = {
  ...process.env,
  NODE_ENV: "production",
  MEKKA_PUBLIC_URL:
    process.env.MEKKA_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    `http://127.0.0.1:${port}`,
  AUTH_PUBLIC_ORIGIN:
    process.env.AUTH_PUBLIC_ORIGIN ??
    process.env.MEKKA_PUBLIC_URL ??
    process.env.NEXT_PUBLIC_SITE_URL ??
    `http://127.0.0.1:${port}`,
  MEKKA_AUTH_SESSION_SECRET:
    process.env.MEKKA_AUTH_SESSION_SECRET ??
    createHash("sha256").update(accessToken).digest("base64url"),
  MEKKA_INTERNAL_PROXY_TOKEN: internalProxyToken,
  MEKKA_SQLITE_META_SERVICE: "1",
  SQLITE_META_HOST: process.env.SQLITE_META_HOST ?? "127.0.0.1",
  SQLITE_META_PORT: process.env.SQLITE_META_PORT ?? "3001",
  SQLITE_META_DATA_DIRECTORY:
    process.env.SQLITE_META_DATA_DIRECTORY ?? path.join(workspaceRoot, ".local/sqlite-meta"),
  STUDIO_BACKEND_API_URL:
    process.env.STUDIO_BACKEND_API_URL ?? "http://127.0.0.1:3001",
};

const sqliteMeta = spawn(
  process.platform === "win32" ? "bun.exe" : "bun",
  [path.join(workspaceRoot, "apps/sqlite-meta/dist/index.js")],
  { cwd: workspaceRoot, env: environment, stdio: "inherit" },
);
const studio = spawn(
  process.execPath,
  [path.join(studioRoot, "scripts/serve.js")],
  { cwd: studioRoot, env: environment, stdio: "inherit" },
);

let isStopping = false;
function stop(signal = "SIGTERM") {
  if (isStopping) return;
  isStopping = true;
  if (!studio.killed) studio.kill(signal);
  if (!sqliteMeta.killed) sqliteMeta.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => stop(signal));
}

for (const [name, child] of [
  ["Studio", studio],
  ["sqlite-meta", sqliteMeta],
]) {
  child.on("error", (error) => {
    console.error(`[production] ${name} failed to start:`, error);
    stop();
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (!isStopping) {
      console.error(`[production] ${name} exited unexpectedly`, { code, signal });
      process.exitCode = code ?? 1;
      stop();
    }
  });
}
