import assert from "node:assert/strict";
import { test } from "vitest";

import { toWebHandler } from "@/compat/next/api";
import nextHandler from "@/pages/api/platform/sqlite-meta/[ref]/[...path]";

const handleRequest = toWebHandler(nextHandler);
const originalBackendUrl = process.env.STUDIO_BACKEND_API_URL;
const originalInternalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN;
const originalNodeEnv = process.env.NODE_ENV;
const originalFetch = globalThis.fetch;
process.env.STUDIO_BACKEND_API_URL = "https://sqlite-meta.example.test";

try {
  let upstreamUrl: string | undefined;
  let upstreamIdempotencyKey: string | null = null;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    upstreamUrl = request.url;
    upstreamIdempotencyKey = request.headers.get("idempotency-key");
    return Response.json({
      name: "tasks",
      columns: [
        {
          name: "id",
          type: "INTEGER",
          nullable: false,
          primaryKeyPosition: 1,
          defaultValue: null,
        },
      ],
      primaryKey: ["id"],
      indexes: [],
    });
  };

  const response = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/tables/tasks",
    ),
    params: { ref: "local", path: "tables/tasks" },
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, "https://sqlite-meta.example.test/tables/tasks");
  assert.equal(new URL(upstreamUrl!).pathname, "/tables/tasks");
  assert.deepEqual(await response.json(), {
    name: "tasks",
    columns: [
      {
        name: "id",
        type: "INTEGER",
        nullable: false,
        primaryKeyPosition: 1,
        defaultValue: null,
      },
    ],
    primaryKey: ["id"],
    indexes: [],
  });

  upstreamUrl = undefined;
  upstreamIdempotencyKey = null;
  const deletion = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/tables/tasks?expected_schema_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      {
        method: "DELETE",
        headers: { "idempotency-key": "sqlite-proxy-delete-001" },
      },
    ),
    params: { ref: "local", path: "tables/tasks" },
  });

  assert.equal(deletion.status, 200);
  assert.equal(
    upstreamUrl,
    "https://sqlite-meta.example.test/tables/tasks?expected_schema_hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(upstreamIdempotencyKey, "sqlite-proxy-delete-001");

  const fetchBeforeInvalidBackend = upstreamUrl;
  for (const invalidBackend of [
    "not a url",
    "file:///tmp/sqlite-meta",
    "https://user:password@backend.example.test",
    "https://backend.example.test?target=sqlite-meta",
    "http://studio.local/api/platform/sqlite-meta/local",
    "http://studio.local",
    "https://studio.local",
    "http://localhost:8082",
  ]) {
    process.env.STUDIO_BACKEND_API_URL = invalidBackend;
    const invalid = await handleRequest({
      request: new Request(
        "http://studio.local/api/platform/sqlite-meta/local/schema/health",
        invalidBackend === "http://localhost:8082" || invalidBackend === "https://studio.local"
          ? { headers: { "x-forwarded-host": "localhost:8082" } }
          : undefined,
      ),
      params: { ref: "local", path: "schema/health" },
    });
    assert.equal(invalid.status, 503, invalidBackend);
    assert.equal(upstreamUrl, fetchBeforeInvalidBackend, invalidBackend);
  }

  process.env.STUDIO_BACKEND_API_URL = "http://127.0.0.1:3001";
  const loopbackBackend = await handleRequest({
    request: new Request(
      "http://127.0.0.1:8082/api/platform/sqlite-meta/local/schema/health",
    ),
    params: { ref: "local", path: "schema/health" },
  });
  assert.equal(loopbackBackend.status, 200);
  assert.equal(upstreamUrl, "http://127.0.0.1:3001/schema/health");

  process.env.STUDIO_BACKEND_API_URL = "https://sqlite-meta.example.test";

  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.MEKKA_INTERNAL_PROXY_TOKEN = "sqlite-proxy-production-token";
  const unauthorized = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/schema/health",
    ),
    params: { ref: "local", path: "schema/health" },
  });
  assert.equal(unauthorized.status, 401);

  const authorized = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/schema/health",
      { headers: { "x-mekka-internal-proxy": "sqlite-proxy-production-token" } },
    ),
    params: { ref: "local", path: "schema/health" },
  });
  assert.equal(authorized.status, 200);

  const engineStatus = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/engine/status",
      { headers: { "x-mekka-internal-proxy": "sqlite-proxy-production-token" } },
    ),
    params: { ref: "local", path: "engine/status" },
  });
  assert.equal(engineStatus.status, 200);
  assert.equal(upstreamUrl, "https://sqlite-meta.example.test/engine/status");

  upstreamIdempotencyKey = "not-reset";
  const engineTest = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/engine/test-connection",
      {
        method: "POST",
        headers: { "x-mekka-internal-proxy": "sqlite-proxy-production-token" },
      },
    ),
    params: { ref: "local", path: "engine/test-connection" },
  });
  assert.equal(engineTest.status, 200);
  assert.equal(upstreamUrl, "https://sqlite-meta.example.test/engine/test-connection");
  assert.equal(upstreamIdempotencyKey, null);

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    upstreamUrl = request.url;
    upstreamIdempotencyKey = request.headers.get("idempotency-key");
    if (request.method === "GET" && request.url.endsWith("/previews")) {
      return Response.json([
        {
          name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
          state: "failed",
          resourceId: "id-mekka-org-main",
          hostname: null,
          createdAt: 1,
          updatedAt: 2,
          promotedAt: null,
          errorCode: "ENGINE_NOT_FOUND",
          errorMessage: "The provider resource no longer exists; delete the preview.",
          schemaHash: "a".repeat(64),
        },
      ]);
    }
    if (request.url.endsWith("/status")) {
      return Response.json({
        name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
        state: "ready",
        resourceId: "id-mekka-org-main",
        hostname: "mekka-org-main.example.turso.io",
        createdAt: 1,
        updatedAt: 2,
        promotedAt: null,
        errorCode: null,
        errorMessage: null,
        schemaHash: "a".repeat(64),
      });
    }
    if (request.url.endsWith("/promote")) {
      throw new Error("unreachable");
    }
    return Response.json({
      name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
      state: "ready",
      resourceId: "id-mekka-org-main",
      hostname: "mekka-org-main.example.turso.io",
      createdAt: 1,
      updatedAt: 1,
      promotedAt: null,
      errorCode: null,
      errorMessage: null,
      schemaHash: "a".repeat(64),
    });
  };

  upstreamUrl = undefined;
  upstreamIdempotencyKey = null;
  const previewHeaders = { "x-mekka-internal-proxy": "sqlite-proxy-production-token" };
  const created = await handleRequest({
    request: new Request("http://studio.local/api/platform/sqlite-meta/local/previews", {
      method: "POST",
      headers: previewHeaders,
    }),
    params: { ref: "local", path: "previews" },
  });
  assert.equal(created.status, 200);
  assert.equal(upstreamUrl, "https://sqlite-meta.example.test/previews");
  assert.equal(upstreamIdempotencyKey, null);
  const createdBody = await created.json();
  assert.equal(createdBody.state, "ready");
  assert.equal(JSON.stringify(createdBody).includes("db-token"), false);

  const listed = await handleRequest({
    request: new Request("http://studio.local/api/platform/sqlite-meta/local/previews", {
      headers: previewHeaders,
    }),
    params: { ref: "local", path: "previews" },
  });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody[0].state, "failed");
  assert.equal(JSON.stringify(listedBody).includes("db-token"), false);

  const refreshed = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/status",
      { headers: previewHeaders },
    ),
    params: {
      ref: "local",
      path: "previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/status",
    },
  });
  assert.equal(refreshed.status, 200);

  upstreamIdempotencyKey = null;
  const promoteWithoutKey = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promote",
      {
        method: "POST",
        headers: { ...previewHeaders, "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      },
    ),
    params: {
      ref: "local",
      path: "previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promote",
    },
  });
  assert.equal(promoteWithoutKey.status, 400);
  assert.equal(upstreamIdempotencyKey, null);

  const hiddenPath = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promoted",
      { headers: previewHeaders },
    ),
    params: {
      ref: "local",
      path: "previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promoted",
    },
  });
  assert.equal(hiddenPath.status, 404);

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    upstreamUrl = request.url;
    upstreamIdempotencyKey = request.headers.get("idempotency-key");
    return Response.json({ error: { code: "conflict" } }, { status: 409 });
  };

  const promoteConflict = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/local/previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promote",
      {
        method: "POST",
        headers: {
          ...previewHeaders,
          "content-type": "application/json",
          "idempotency-key": "sqlite-proxy-promote-001",
        },
        body: JSON.stringify({ confirmed: true }),
      },
    ),
    params: {
      ref: "local",
      path: "previews/mekka-org-main-project-main-environmen-1a2b3c4d5e6f/promote",
    },
  });
  assert.equal(promoteConflict.status, 409);
  assert.equal(upstreamIdempotencyKey, "sqlite-proxy-promote-001");

  const unknownProject = await handleRequest({
    request: new Request(
      "http://studio.local/api/platform/sqlite-meta/other/schema/health",
      { headers: { "x-mekka-internal-proxy": "sqlite-proxy-production-token" } },
    ),
    params: { ref: "other", path: "schema/health" },
  });
  assert.equal(unknownProject.status, 404);
} finally {
  globalThis.fetch = originalFetch;
  if (originalBackendUrl === undefined)
    delete process.env.STUDIO_BACKEND_API_URL;
  else process.env.STUDIO_BACKEND_API_URL = originalBackendUrl;
  if (originalInternalProxyToken === undefined)
    delete process.env.MEKKA_INTERNAL_PROXY_TOKEN;
  else process.env.MEKKA_INTERNAL_PROXY_TOKEN = originalInternalProxyToken;
  if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
}

test("sqlite-meta proxy assertions completed", () => {});
