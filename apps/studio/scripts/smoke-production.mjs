#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(studioRoot, "../..");
const dataDirectory = await mkdtemp(path.join(tmpdir(), "mekka-production-smoke-"));
const [studioPort, sqliteMetaPort, emailPort] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
]);
const accessToken = "mekka-production-smoke-access-token";
const baseUrl = `http://127.0.0.1:${studioPort}`;
const authorization = `Basic ${Buffer.from(`smoke:${accessToken}`).toString("base64")}`;
let deliveredEmail = null;
const emailServer = createHttpServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/emails") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  deliveredEmail = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "production-smoke-email" }));
});
await new Promise((resolve, reject) => {
  emailServer.once("error", reject);
  emailServer.listen(emailPort, "127.0.0.1", resolve);
});
const child = spawn(
  process.platform === "win32" ? "bun.exe" : "bun",
  ["run", "--cwd", "apps/studio", "start:production"],
  {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      NODE_ENV: "production",
      MODE: "production",
      PORT: String(studioPort),
      SQLITE_META_PORT: String(sqliteMetaPort),
      STUDIO_BACKEND_API_URL: `http://127.0.0.1:${sqliteMetaPort}`,
      SQLITE_META_DATA_DIRECTORY: dataDirectory,
      MEKKA_STUDIO_ACCESS_TOKEN: accessToken,
      MEKKA_PUBLIC_URL: baseUrl,
      MEKKA_RESEND_API_KEY: "production-smoke-email-key",
      MEKKA_AUTH_EMAIL_FROM: "Mekka Smoke <auth@example.test>",
      MEKKA_RESEND_API_URL: `http://127.0.0.1:${emailPort}/emails`,
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

  const email = `production-smoke-${Date.now()}@example.test`;
  const password = "correct-horse-battery-staple";
  const authBase = "/auth/org-local/local/env-local/branch-main/1";
  await requestJson(`${authBase}/sign-up/email`, {
    authorization,
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({ email, name: "Production Smoke", password }),
  });
  await expectStatus(
    `/api/platform/project-auth/local/verification-code?email=${encodeURIComponent(email)}`,
    404,
    { authorization },
  );
  const verificationCode = deliveredEmail?.text?.match(/\b\d{6}\b/)?.[0];
  if (typeof verificationCode !== "string") {
    throw new Error("Production email provider did not receive a verification code.");
  }
  await requestJson(`${authBase}/email-otp/verify-email`, {
    authorization,
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({ email, otp: verificationCode }),
  });
  const login = await requestJson(`${authBase}/sign-in/email`, {
    authorization,
    method: "POST",
    headers: { origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
  if (typeof login.accessToken !== "string" || typeof login.refreshToken !== "string") {
    throw new Error("Production Auth login did not return tokens.");
  }
  const agentGrant = await requestJson("/api/platform/project-auth/local/agent-token", {
    authorization,
    method: "POST",
    body: JSON.stringify({ accessToken: login.accessToken }),
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
      columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
      expectedSchemaHash: health.schemaHash,
    }),
  });
  await expectStatus(`/api/platform/sqlite-meta/local/tables/${table}`, 200, {
    authorization,
  });
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

  console.log("[production-smoke] packaged Studio, SQLite, Auth, email, and MCP lifecycle passed");
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
  await new Promise((resolve) => emailServer.close(resolve));
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
