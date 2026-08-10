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
