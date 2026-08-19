import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSqliteMetaApp } from "../../apps/sqlite-meta/src/app";
import { openLibsqlEngine } from "../../packages/engine-core/src/index";
import {
  createCorrelationId,
  createTenantContext,
  parseTenantIdentity,
  tenantHeaders,
} from "../../packages/protocol/src/index";
import { createAsyncSchemaManifestCache } from "../../packages/schema-manifest/src/index";

const root = resolve(import.meta.dir, "../..");
const runId = `${Date.now()}-${process.pid}`;
const image = `mekka/libsql-smoke:${runId}`;
const sourceVolume = `mekka-libsql-source-${runId}`;
const restoreVolume = `mekka-libsql-restore-${runId}`;
const sourceContainer = `mekka-libsql-source-${runId}`;
const restoreContainer = `mekka-libsql-restore-${runId}`;
const temporaryDirectory = mkdtempSync(join(tmpdir(), "mekka-libsql-smoke-"));
const publicKeyPath = join(temporaryDirectory, "public.pem");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });

const validToken = createToken(privateKey, Math.floor(Date.now() / 1000) + 900);
const expiredToken = createToken(privateKey, Math.floor(Date.now() / 1000) - 60);
const wrongToken = createToken(
  generateKeyPairSync("ed25519").privateKey,
  Math.floor(Date.now() / 1000) + 900,
);
process.env.MEKKA_LIBSQL_SMOKE_TOKEN = validToken;

try {
  docker(["build", "--tag", image, "--file", "deploy/libsql/Dockerfile", "deploy/libsql"]);
  docker(["volume", "create", sourceVolume]);
  docker(["volume", "create", restoreVolume]);

  let sourceUrl = startContainer(sourceContainer, sourceVolume);
  await waitForReady(sourceUrl, sourceContainer);
  await expectAuthFailure(sourceUrl, undefined);
  await expectAuthFailure(sourceUrl, wrongToken);
  await expectAuthFailure(sourceUrl, expiredToken);

  const client = openLibsqlEngine({
    url: sourceUrl,
    tokenReference: "MEKKA_LIBSQL_SMOKE_TOKEN",
    allowLocalhost: true,
  });
  await client.execute({
    sql: "CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  });
  await client.execute({
    sql: "INSERT INTO smoke_items (id, value) VALUES (?, ?)",
    parameters: [1, "created"],
  });
  await client.execute({
    sql: "UPDATE smoke_items SET value = ? WHERE id = ?",
    parameters: ["updated", 1],
  });
  await client.execute({
    sql: "INSERT INTO smoke_items (id, value) VALUES (?, ?)",
    parameters: [2, "delete-me"],
  });
  await client.execute({ sql: "DELETE FROM smoke_items WHERE id = ?", parameters: [2] });
  assertValue(await readValue(client, 1), "updated", "CRUD update");
  assertValue(await readValue(client, 2), null, "CRUD delete");

  await client
    .transaction(async (transaction) => {
      await transaction.execute({
        sql: "INSERT INTO smoke_items (id, value) VALUES (?, ?)",
        parameters: [99, "must-rollback"],
      });
      throw new Error("rollback smoke");
    })
    .catch((error) => {
      if (!(error instanceof Error) || error.message !== "rollback smoke") throw error;
    });
  assertValue(await readValue(client, 99), null, "transaction rollback");
  await smokeSqliteMeta(client);
  smokeOpenCodeMcp(sourceUrl);
  await smokeSqliteMetaRuntime(sourceUrl);
  await client.close();

  docker(["restart", sourceContainer]);
  sourceUrl = containerUrl(sourceContainer);
  await waitForReady(sourceUrl, sourceContainer);
  const restarted = openLibsqlEngine({
    url: sourceUrl,
    tokenReference: "MEKKA_LIBSQL_SMOKE_TOKEN",
    allowLocalhost: true,
  });
  assertValue(await readValue(restarted, 1), "updated", "restart persistence");
  await restarted.close();

  docker(["stop", "--time", "30", sourceContainer]);
  docker([
    "run",
    "--rm",
    "--volume",
    `${sourceVolume}:/from:ro`,
    "--volume",
    `${temporaryDirectory}:/backup`,
    "--entrypoint",
    "/bin/sh",
    "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    "-c",
    "tar -C /from -czf /backup/libsql-data.tgz .",
  ]);
  docker(["start", sourceContainer]);
  sourceUrl = containerUrl(sourceContainer);
  await waitForReady(sourceUrl, sourceContainer);
  const afterBackup = openLibsqlEngine({
    url: sourceUrl,
    tokenReference: "MEKKA_LIBSQL_SMOKE_TOKEN",
    allowLocalhost: true,
  });
  await afterBackup.execute({
    sql: "INSERT INTO smoke_items (id, value) VALUES (?, ?)",
    parameters: [3, "after-backup"],
  });
  await afterBackup.close();

  docker([
    "run",
    "--rm",
    "--volume",
    `${restoreVolume}:/to`,
    "--volume",
    `${temporaryDirectory}:/backup:ro`,
    "--entrypoint",
    "/bin/sh",
    "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    "-c",
    "tar -C /to -xzf /backup/libsql-data.tgz",
  ]);
  const restoreUrl = startContainer(restoreContainer, restoreVolume);
  await waitForReady(restoreUrl, restoreContainer);
  const restored = openLibsqlEngine({
    url: restoreUrl,
    tokenReference: "MEKKA_LIBSQL_SMOKE_TOKEN",
    allowLocalhost: true,
  });
  assertValue(await readValue(restored, 1), "updated", "restore data");
  assertValue(await readValue(restored, 3), null, "restore snapshot boundary");
  await restored.close();
  await expectAuthFailure(restoreUrl, undefined);

  console.log(
    "[libsql-smoke] authenticated CRUD, rollback, auth denial, restart, backup and restore passed",
  );
} finally {
  for (const container of [sourceContainer, restoreContainer]) {
    docker(["rm", "--force", container], true);
  }
  for (const volume of [sourceVolume, restoreVolume]) {
    docker(["volume", "rm", "--force", volume], true);
  }
  docker(["image", "rm", "--force", image], true);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function createToken(key: Parameters<typeof sign>[2], expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ p: { rw: { ns: ["default"] } }, exp: expiresAt }),
  ).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

function startContainer(name: string, volume: string): string {
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::8080",
    "--env",
    "SQLD_NODE=primary",
    "--env",
    "SQLD_DB_PATH=/var/lib/sqld/mekka-data",
    "--env",
    "SQLD_HTTP_LISTEN_ADDR=0.0.0.0:8080",
    "--env",
    "SQLD_AUTH_JWT_KEY_FILE=/run/secrets/public.pem",
    "--volume",
    `${volume}:/var/lib/sqld`,
    "--volume",
    `${publicKeyPath}:/run/secrets/public.pem:ro`,
    image,
  ]);
  return containerUrl(name);
}

function containerUrl(name: string): string {
  const binding = docker(["port", name, "8080/tcp"]);
  const port = /:(\d+)\s*$/.exec(binding)?.[1];
  if (port === undefined) throw new Error(`Could not resolve the published port for ${name}.`);
  return `http://127.0.0.1:${port}`;
}

async function waitForReady(url: string, container: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const engine = openLibsqlEngine({
      url,
      tokenReference: "MEKKA_LIBSQL_SMOKE_TOKEN",
      allowLocalhost: true,
      requestTimeoutMs: 1_000,
    });
    try {
      await engine.execute({ sql: "SELECT 1 AS ready" });
      await engine.close();
      return;
    } catch {
      await engine.close();
      // The container may still be starting.
    }
    await Bun.sleep(500);
  }
  throw new Error(`libSQL did not become ready at ${url}. ${docker(["logs", container], true)}`);
}

async function expectAuthFailure(url: string, token: string | undefined): Promise<void> {
  const reference = `MEKKA_LIBSQL_INVALID_${Math.random().toString(36).slice(2)}`;
  if (token !== undefined) process.env[reference] = token;
  const client = openLibsqlEngine({
    url,
    ...(token === undefined ? {} : { tokenReference: reference }),
    allowLocalhost: true,
  });
  try {
    await client.execute({ sql: "SELECT 1" });
  } catch {
    await client.close();
    delete process.env[reference];
    return;
  }
  await client.close();
  delete process.env[reference];
  throw new Error("libSQL unexpectedly accepted invalid or absent credentials.");
}

async function readValue(
  client: ReturnType<typeof openLibsqlEngine>,
  id: number,
): Promise<string | null> {
  const row = (
    await client.execute({
      sql: "SELECT value FROM smoke_items WHERE id = ?",
      parameters: [id],
    })
  ).rows[0];
  return typeof row?.value === "string" ? row.value : null;
}

async function smokeSqliteMeta(engine: ReturnType<typeof openLibsqlEngine>): Promise<void> {
  const tenant = parseTenantIdentity({
    organizationId: "org-libsql-smoke",
    projectId: "project-libsql-smoke",
    environmentId: "env-libsql-smoke",
    branchId: "branch-main",
    generation: 1,
  });
  const context = createTenantContext({
    tenant,
    actor: { kind: "service", id: "libsql-smoke" },
    capabilities: [
      {
        id: "libsql-smoke-admin",
        tenant,
        actions: [
          "schema:read",
          "schema:manage",
          "data:read",
          "data:write",
          "sql:execute",
          "preview:manage",
        ],
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    ],
    correlationId: createCorrelationId(),
  });
  const app = createSqliteMetaApp({
    authenticate: () => context,
    resolveProject: () => ({
      tenant,
      engine,
      schemaCache: createAsyncSchemaManifestCache(engine),
    }),
    recordAudit: () => undefined,
    checkpointDirectory: temporaryDirectory,
  });
  const initial = await metaRequest(app, context.tenant, "/schema/health");
  assertStatus(initial, 200, "SQLite Meta health");
  const initialBody = (await initial.json()) as { schemaHash: string };
  const table = await metaRequest(
    app,
    context.tenant,
    "/tables",
    "POST",
    {
      name: "runtime_items",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "value", type: "TEXT", nullable: false, primaryKey: false },
      ],
      expectedSchemaHash: initialBody.schemaHash,
    },
    "libsql-smoke-create-table",
  );
  assertStatus(table, 200, "SQLite Meta create table");
  const inserted = await metaRequest(
    app,
    context.tenant,
    "/rows/runtime_items",
    "POST",
    {
      values: { id: 1, value: "remote-runtime" },
    },
    "libsql-smoke-insert-row",
  );
  assertStatus(inserted, 200, "SQLite Meta insert row");
  const beforeColumn = await metaRequest(app, context.tenant, "/schema/health");
  const beforeColumnBody = (await beforeColumn.json()) as { schemaHash: string };
  const column = await metaRequest(
    app,
    context.tenant,
    "/columns",
    "POST",
    {
      table: "runtime_items",
      name: "description",
      type: "TEXT",
      nullable: true,
      expectedSchemaHash: beforeColumnBody.schemaHash,
    },
    "libsql-smoke-add-column",
  );
  assertStatus(column, 200, "SQLite Meta schema mutation");
  const rows = await metaRequest(app, context.tenant, "/rows/runtime_items?limit=10");
  assertStatus(rows, 200, "SQLite Meta read rows");
  const rowBody = (await rows.json()) as { rows: Array<{ value?: unknown }> };
  assertValue(
    rowBody.rows[0]?.value === "remote-runtime" ? "remote-runtime" : null,
    "remote-runtime",
    "SQLite Meta remote row",
  );
  const sql = await metaRequest(app, context.tenant, "/sql", "POST", {
    sql: "SELECT id, value FROM runtime_items LIMIT 10",
  });
  assertStatus(sql, 200, "SQLite Meta SQL read");
  const previews = await metaRequest(app, context.tenant, "/previews", "POST");
  assertStatus(previews, 501, "self-hosted previews unsupported");
  const current = await metaRequest(app, context.tenant, "/schema/health");
  const currentBody = (await current.json()) as { schemaHash: string };
  const destructive = await metaRequest(
    app,
    context.tenant,
    `/tables/runtime_items?expected_schema_hash=${currentBody.schemaHash}`,
    "DELETE",
    undefined,
    "libsql-smoke-delete-table",
  );
  assertStatus(destructive, 501, "remote destructive DDL without backup provider");
}

async function metaRequest(
  app: ReturnType<typeof createSqliteMetaApp>,
  tenant: ReturnType<typeof parseTenantIdentity>,
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  const headers = new Headers({
    [tenantHeaders.organizationId]: tenant.organizationId,
    [tenantHeaders.projectId]: tenant.projectId,
    [tenantHeaders.environmentId]: tenant.environmentId,
    [tenantHeaders.branchId]: tenant.branchId,
    [tenantHeaders.generation]: String(tenant.generation),
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  return app.handle(
    new Request(`http://sqlite-meta.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

function assertStatus(response: Response, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label} failed: expected HTTP ${expected}, received ${response.status}.`);
  }
}

function smokeOpenCodeMcp(url: string): void {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "opencode";
  const commandPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "opencode"] : [];
  const output = execFileSync(
    command,
    [
      ...commandPrefix,
      "run",
      "--format",
      "json",
      "Use only the mekka-local MCP server. Call inspect_schema and report only table names. Do not read repository files and do not use shell tools.",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      env: {
        ...process.env,
        MEKKA_DATA_ENGINE: "libsql-remote",
        MEKKA_LIBSQL_URL: url,
        MEKKA_LIBSQL_TOKEN_ENV: "MEKKA_LIBSQL_SMOKE_TOKEN",
        MEKKA_LOCAL_DEV: "1",
      },
    },
  );
  if (!output.includes("mekka-local_inspect_schema") || !output.includes("runtime_items")) {
    throw new Error("OpenCode did not inspect the remote libSQL schema through MCP.");
  }
}

async function smokeSqliteMetaRuntime(libsqlUrl: string): Promise<void> {
  const port = await freePort();
  const dataDirectory = join(temporaryDirectory, "sqlite-meta-control");
  const proxyToken = "libsql-runtime-proxy-token-1234567890";
  const child = spawn(
    process.platform === "win32" ? "bun.exe" : "bun",
    ["apps/sqlite-meta/src/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        MEKKA_LOCAL_DEV: "1",
        MEKKA_SQLITE_META_SERVICE: "1",
        MEKKA_DATA_ENGINE: "libsql-remote",
        MEKKA_LIBSQL_URL: libsqlUrl,
        MEKKA_LIBSQL_TOKEN_ENV: "MEKKA_LIBSQL_SMOKE_TOKEN",
        MEKKA_INTERNAL_PROXY_TOKEN: proxyToken,
        SQLITE_META_HOST: "127.0.0.1",
        SQLITE_META_PORT: String(port),
        SQLITE_META_DATA_DIRECTORY: dataDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const headers = new Headers({
    "x-mekka-internal-proxy": proxyToken,
    [tenantHeaders.organizationId]: "org-local",
    [tenantHeaders.projectId]: "local",
    [tenantHeaders.environmentId]: "env-local",
    [tenantHeaders.branchId]: "branch-main",
    [tenantHeaders.generation]: "1",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    let health: Response | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        health = await fetch(`${baseUrl}/schema/health`, {
          headers,
          signal: AbortSignal.timeout(1_000),
        });
        if (health.status === 200) break;
      } catch {
        // Runtime may still be starting.
      }
      await Bun.sleep(500);
    }
    if (health?.status !== 200) throw new Error(`sqlite-meta did not become ready. ${output}`);
    const schema = (await health.json()) as { schemaHash: string };
    const createHeaders = new Headers(headers);
    createHeaders.set("content-type", "application/json");
    createHeaders.set("idempotency-key", "runtime-server-create-001");
    const created = await fetch(`${baseUrl}/tables`, {
      method: "POST",
      headers: createHeaders,
      body: JSON.stringify({
        name: "server_items",
        columns: [
          { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
          { name: "value", type: "TEXT", nullable: false, primaryKey: false },
        ],
        expectedSchemaHash: schema.schemaHash,
      }),
    });
    assertStatus(created, 200, "sqlite-meta runtime create table");
    const insertHeaders = new Headers(headers);
    insertHeaders.set("content-type", "application/json");
    insertHeaders.set("idempotency-key", "runtime-server-insert-001");
    const inserted = await fetch(`${baseUrl}/rows/server_items`, {
      method: "POST",
      headers: insertHeaders,
      body: JSON.stringify({ values: { id: 1, value: "runtime-process" } }),
    });
    assertStatus(inserted, 200, "sqlite-meta runtime insert row");
    const rows = await fetch(`${baseUrl}/rows/server_items?limit=10`, { headers });
    assertStatus(rows, 200, "sqlite-meta runtime read rows");
    const body = (await rows.json()) as { rows: Array<{ value?: unknown }> };
    assertValue(
      body.rows[0]?.value === "runtime-process" ? "runtime-process" : null,
      "runtime-process",
      "sqlite-meta runtime remote row",
    );
    const projectFiles = readdirSync(dataDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
      .map((entry) => entry.name)
      .filter((name) => name !== "agent-access.sqlite");
    if (projectFiles.length !== 0) {
      throw new Error(`Remote runtime created local project databases: ${projectFiles.join(", ")}`);
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolveChild) => child.once("exit", () => resolveChild())),
      Bun.sleep(5_000).then(() => undefined),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function assertValue(actual: string | null, expected: string | null, label: string): void {
  if (actual !== expected)
    throw new Error(`${label} failed: expected ${expected}, received ${actual}.`);
}

function docker(args: string[], ignoreFailure = false): string {
  try {
    return execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (ignoreFailure) return "";
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    throw new Error(`docker ${args.join(" ")} failed. ${stderr}`.trim(), { cause: error });
  }
}
