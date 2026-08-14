#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(studioRoot, "../..");
const internalProxyToken =
  process.env.MEKKA_INTERNAL_PROXY_TOKEN ?? randomBytes(32).toString("base64url");
const accessToken = process.env.MEKKA_STUDIO_ACCESS_TOKEN ?? "";
const port = process.env.PORT ?? "8082";
Object.assign(process.env, {
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
  MEKKA_SQLITE_META_ENTRY: path.join(workspaceRoot, "apps/sqlite-meta/dist/index.js"),
})

await import(pathToFileURL(path.join(studioRoot, "scripts/local-runtime.js")).href)
