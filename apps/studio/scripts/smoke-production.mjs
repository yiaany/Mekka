#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(studioRoot, "../..");
const dataDirectory = await mkdtemp(path.join(tmpdir(), "mekka-production-smoke-"));
const [studioPort, sqliteMetaPort] = await Promise.all([freePort(), freePort()]);
const accessToken = "mekka-production-smoke-access-token";
const baseUrl = `http://127.0.0.1:${studioPort}`;
const authorization = `Basic ${Buffer.from(`smoke:${accessToken}`).toString("base64")}`;
const child = spawn(
  process.platform === "win32" ? "bun.exe" : "bun",
  ["run", "--cwd", "apps/studio", "start:production"],
  {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      MODE: "production",
      MEKKA_LOCAL_DEV: "1",
      PORT: String(studioPort),
      SQLITE_META_PORT: String(sqliteMetaPort),
      STUDIO_BACKEND_API_URL: `http://127.0.0.1:${sqliteMetaPort}`,
      SQLITE_META_DATA_DIRECTORY: dataDirectory,
      MEKKA_STUDIO_ACCESS_TOKEN: accessToken,
      MEKKA_PUBLIC_URL: baseUrl,
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

try {
  await waitForReady();
  await expectStatus("/project/local/editor", 401);
  await expectStatus("/project/local/editor", 200, { authorization });
  await expectStatus("/api/platform/projects/default", 404, { authorization });
  await expectStatus("/api/platform/sqlite-meta/other/schema/health", 404, {
    authorization,
  });

  const initialHealth = await requestJson("/api/platform/sqlite-meta/local/schema/health", {
    authorization,
  });
  await requestJson("/api/platform/sqlite-meta/local/tables", {
    authorization,
    method: "POST",
    headers: { "idempotency-key": "production-smoke-create-users" },
    body: JSON.stringify({
      name: "users",
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "name", type: "TEXT", nullable: false, primaryKey: false },
      ],
      expectedSchemaHash: initialHealth.schemaHash,
    }),
  });
  for (const [id, name] of [
    [1, "Alice"],
    [2, "Sam"],
  ]) {
    await requestJson("/api/platform/sqlite-meta/local/rows/users", {
      authorization,
      method: "POST",
      headers: { "idempotency-key": `production-smoke-user-${id}` },
      body: JSON.stringify({ values: { id, name } }),
    });
  }
  const users = await requestJson("/api/platform/sqlite-meta/local/rows/users?limit=50&offset=0", {
    authorization,
  });
  if (
    users.totalCount !== 2 ||
    users.rows?.[0]?.name !== "Alice" ||
    users.rows?.[1]?.name !== "Sam"
  ) {
    throw new Error("Official runtime did not persist the demo users Alice and Sam.");
  }

  const email = `production-smoke-${Date.now()}@example.test`;
  const password = "correct-horse-battery-staple";
  const authBase = "/auth/org-local/local/env-local/branch-main/1";
  await requestJson(`${authBase}/sign-up/email`, {
    authorization,
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({ email, name: "Production Smoke", password }),
  });
  const verification = await requestJson(
    `/api/platform/project-auth/local/verification-code?email=${encodeURIComponent(email)}`,
    { authorization },
  );
  const verificationCode = verification.code;
  if (typeof verificationCode !== "string") {
    throw new Error("Local Auth did not expose a verification code.");
  }
  await requestJson(`${authBase}/email-otp/verify-email`, {
    authorization,
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({ email, otp: verificationCode }),
  });
  const loginResponse = await expectStatus(`${authBase}/sign-in/email`, 200, {
    authorization,
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  const login = await loginResponse.json();
  if (typeof login.accessToken !== "string" || typeof login.refreshToken !== "string") {
    throw new Error("Production Auth login did not return tokens.");
  }
  const sessionCookie = cookieFromSetCookie(loginResponse.headers.get("set-cookie"));
  const sessionTokens = await requestJson(`${authBase}/token`, {
    authorization,
    method: "POST",
    headers: { cookie: sessionCookie, origin: baseUrl },
  });
  if (
    typeof sessionTokens.accessToken !== "string" ||
    typeof sessionTokens.refreshToken !== "string"
  ) {
    throw new Error("Production Auth cookie did not resolve to an active session.");
  }
  const agentGrant = await requestJson("/api/platform/project-auth/local/agent-token", {
    authorization,
    method: "POST",
    body: JSON.stringify({ accessToken: sessionTokens.accessToken }),
  });
  if (typeof agentGrant.token !== "string" || typeof agentGrant.expiresAt !== "number") {
    throw new Error("Production Auth did not issue a temporary Agent Access token.");
  }
  const metadata = await requestJson("/.well-known/oauth-protected-resource/mcp");
  if (metadata.resource !== `${baseUrl}/mcp`) {
    throw new Error("MCP protected-resource metadata used the wrong public endpoint.");
  }
  const missingMcpAuth = await expectStatus("/mcp", 401, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  if (!missingMcpAuth.headers.get("www-authenticate")?.includes("resource_metadata=")) {
    throw new Error("MCP authentication challenge did not publish resource metadata.");
  }
  await expectStatus("/mcp", 401, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${login.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  const initializedMcp = await requestJson("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${agentGrant.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "production-smoke", version: "1.0.0" },
      },
    }),
  });
  if (initializedMcp?.result?.protocolVersion !== "2025-11-25") {
    throw new Error("Production MCP endpoint did not initialize.");
  }
  const readMutation = await callMcpTool(agentGrant.token, "propose_migration", {
    migrationId: "read-token-must-not-write",
    idempotencyKey: `read-token-denied-${Date.now()}`,
    sql: "CREATE TABLE read_token_must_not_write (id INTEGER)",
  });
  if (readMutation.isError !== true) {
    throw new Error("Read-only Agent Access unexpectedly received mutation scope.");
  }

  const writeGrant = await requestJson("/api/platform/project-auth/local/agent-token", {
    authorization,
    method: "POST",
    body: JSON.stringify({ accessToken: sessionTokens.accessToken, mode: "write" }),
  });
  if (
    typeof writeGrant.token !== "string" ||
    writeGrant.mode !== "write" ||
    writeGrant.tenant?.branchId === "branch-main"
  ) {
    throw new Error("Read-write Agent Access was not isolated to a preview branch.");
  }
  const inspected = readMcpToolJson(
    await expectMcpToolSuccess(writeGrant.token, "inspect_schema", {}),
  );
  if (!inspected?.tables?.some((table) => table.name === "users")) {
    throw new Error("MCP inspect did not see the production users table in its preview branch.");
  }
  const postsSql =
    "CREATE TABLE posts (id INTEGER NOT NULL PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL)";
  const proposed = await callMcpTool(writeGrant.token, "propose_migration", {
    migrationId: "create-posts",
    idempotencyKey: "production-smoke-create-posts",
    sql: postsSql,
  });
  const proposalId = readMcpToolJson(proposed)?.proposalId;
  if (typeof proposalId !== "string") throw new Error("MCP did not return a proposal ID.");
  await expectMcpToolSuccess(writeGrant.token, "apply_to_preview", { proposalId });
  await expectMcpToolSuccess(writeGrant.token, "validate_changes", { proposalId });
  const pendingPromotion = readMcpToolJson(
    await expectMcpToolSuccess(writeGrant.token, "request_promotion", { proposalId }),
  );
  if (pendingPromotion?.promotion !== "pending") {
    throw new Error("MCP production promotion did not stop for Studio approval.");
  }
  const blockedWriteResponse = await expectStatus(
    "/api/platform/project-auth/local/agent-token",
    409,
    {
      authorization,
      method: "POST",
      body: JSON.stringify({ accessToken: sessionTokens.accessToken, mode: "write" }),
    },
  );
  const blockedWrite = await blockedWriteResponse.json();
  if (
    blockedWrite.error !== "approval_conflict" ||
    blockedWrite.approval?.proposalId !== proposalId ||
    blockedWrite.approval?.branchId !== writeGrant.tenant.branchId
  ) {
    throw new Error("A second write grant was not blocked by the actor's active approval.");
  }
  const allowedReadGrant = await requestJson("/api/platform/project-auth/local/agent-token", {
    authorization,
    method: "POST",
    body: JSON.stringify({ accessToken: sessionTokens.accessToken, mode: "read" }),
  });
  if (allowedReadGrant.mode !== "read") {
    throw new Error("An active write approval unexpectedly blocked read-only Agent Access.");
  }
  await expectStatus("/api/platform/mcp/approvals", 401, { authorization });
  const applicationAuthorization = `Bearer ${sessionTokens.accessToken}`;
  const approvalList = await requestJson("/api/platform/mcp/approvals", {
    authorization,
    headers: { "x-mekka-application-authorization": applicationAuthorization },
  });
  const approval = approvalList.approvals?.find((candidate) => candidate.proposalId === proposalId);
  if (!approval || approval.sql !== postsSql) {
    throw new Error("Studio approval did not expose the exact proposed SQL.");
  }
  const approvalDecision = await requestJson(
    `/api/platform/mcp/approvals/${encodeURIComponent(approval.approvalId)}`,
    {
      authorization,
      headers: { "x-mekka-application-authorization": applicationAuthorization },
      method: "PATCH",
      body: JSON.stringify({ state: "approved" }),
    },
  );
  if (typeof approvalDecision.executionToken !== "string") {
    throw new Error("Studio approval did not issue an execution step-up token.");
  }
  const withoutStepUp = readMcpToolJson(
    await expectMcpToolSuccess(writeGrant.token, "request_promotion", { proposalId }),
  );
  if (withoutStepUp?.promotion !== "pending") {
    throw new Error("Pre-approval write grant unexpectedly authorized production execution.");
  }
  const appliedPromotion = readMcpToolJson(
    await expectMcpToolSuccess(writeGrant.token, "request_promotion", {
      proposalId,
      executionToken: approvalDecision.executionToken,
    }),
  );
  if (appliedPromotion?.promotion !== "applied") {
    throw new Error("Approved MCP migration was not promoted to production.");
  }
  const posts = await requestJson("/api/platform/sqlite-meta/local/tables/posts", { authorization });
  if (
    posts.name !== "posts" ||
    !posts.columns?.some((column) => column.name === "user_id") ||
    !posts.columns?.some((column) => column.name === "title")
  ) {
    throw new Error("Approved MCP migration did not create the posts table in production.");
  }
  const authUsers = await requestJson("/api/platform/auth-admin/local/users", {
    authorization,
    headers: {
      "x-mekka-organization-id": "org-local",
      "x-mekka-project-id": "local",
      "x-mekka-environment-id": "env-local",
      "x-mekka-branch-id": "branch-main",
      "x-mekka-generation": "1",
    },
  });
  if (!authUsers.users.some((user) => user.email === email)) {
    throw new Error("Registered production Auth user was not visible in Studio.");
  }

  const health = await requestJson("/api/platform/sqlite-meta/local/schema/health", {
    authorization,
  });
  const table = `production_smoke_${Date.now()}`;
  await requestJson("/api/platform/sqlite-meta/local/tables", {
    authorization,
    method: "POST",
    headers: { "idempotency-key": `production-smoke-create-${Date.now()}` },
    body: JSON.stringify({
      name: table,
      columns: [
        { name: "id", type: "INTEGER", nullable: false, primaryKey: true },
        { name: "body", type: "TEXT", nullable: false, primaryKey: false },
      ],
      expectedSchemaHash: health.schemaHash,
    }),
  });
  await expectStatus(`/api/platform/sqlite-meta/local/tables/${table}`, 200, {
    authorization,
  });
  for (const [id, body] of [
    [1, "first"],
    [2, "second"],
  ]) {
    await requestJson(`/api/platform/sqlite-meta/local/rows/${table}`, {
      authorization,
      method: "POST",
      headers: { "idempotency-key": `production-smoke-row-${table}-${id}` },
      body: JSON.stringify({ values: { id, body } }),
    });
  }
  const rows = await requestJson(`/api/platform/sqlite-meta/local/rows/${table}?limit=50&offset=0`, {
    authorization,
  });
  if (
    rows.totalCount !== 2 ||
    rows.rows?.[0]?.body !== "first" ||
    rows.rows?.[1]?.body !== "second"
  ) {
    throw new Error("Production Studio row mutations did not remain responsive and observable.");
  }
  const nextHealth = await requestJson("/api/platform/sqlite-meta/local/schema/health", {
    authorization,
  });
  await requestJson(
    `/api/platform/sqlite-meta/local/tables/${table}?expected_schema_hash=${nextHealth.schemaHash}`,
    {
      authorization,
      method: "DELETE",
      headers: { "idempotency-key": `production-smoke-delete-${Date.now()}` },
    },
  );
  const tables = await requestJson("/api/platform/sqlite-meta/local/tables", {
    authorization,
  });
  if (tables.some((candidate) => candidate.name === table)) {
    throw new Error("Production smoke table was not deleted.");
  }

  console.log("[production-smoke] official Studio, SQLite, local Auth, session, and MCP flow passed");
} catch (error) {
  console.error("[production-smoke] failed:", error);
  if (output.trim()) console.error(output.trim());
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(dataDirectory, { recursive: true, force: true });
}

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production process exited with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Production readiness timed out.");
}

async function expectStatus(pathname, status, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...options.headers, ...(options.authorization ? { authorization: options.authorization } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== status) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `${pathname} returned ${response.status}, expected ${status}. ${responseBody}`.trim(),
    );
  }
  return response;
}

async function requestJson(pathname, options = {}) {
  const response = await expectStatus(pathname, 200, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  return response.json();
}

async function callMcpTool(token, name, args) {
  return requestJson("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }).then((response) => response.result);
}

async function expectMcpToolSuccess(token, name, args) {
  const result = await callMcpTool(token, name, args);
  if (result?.isError === true) {
    throw new Error(`MCP tool ${name} failed: ${JSON.stringify(result.content)}`);
  }
  return result;
}

function readMcpToolJson(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cookieFromSetCookie(value) {
  const match = /(?:__Secure-)?better-auth\.session_token=([^;,\s]+)/.exec(value ?? "");
  if (!match) throw new Error("Production Auth login did not set a session cookie.");
  return `${match[0].split("=")[0]}=${match[1]}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a free TCP port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
