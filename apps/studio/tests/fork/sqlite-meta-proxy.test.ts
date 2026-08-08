import assert from "node:assert/strict";

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
