import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PolicyDocument, policyFormatVersion } from "@mekka/policy-engine";
import {
  createTenantContext,
  ProtocolError,
  type TenantContext,
  tenantHeaders,
} from "@mekka/protocol";
import { readChangefeed } from "@mekka/realtime-core";
import {
  createLocalObjectProvider,
  createObjectStorageCore,
  openStorageAdapter,
  type StorageAdapter,
  type StorageStatement,
  type StorageValue,
} from "@mekka/storage-core";
import {
  createGatewayApp,
  type GatewayMetric,
  type RestQueryExecutor,
  RestQueryTimeoutError,
} from "../src/app";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 59) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function createTemporaryAdapter(): Promise<StorageAdapter> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-gateway-"));
  temporaryDirectories.push(directory);
  return openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "test.sqlite"),
  });
}

const policies: PolicyDocument = {
  formatVersion: policyFormatVersion,
  tables: [
    {
      table: "notes",
      rules: [
        {
          name: "owner-read",
          action: "select",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["id", "body"], deny: ["private_note"] },
        },
        {
          name: "owner-insert",
          action: "insert",
          check: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["id", "owner_id", "body"], deny: ["private_note"] },
        },
        {
          name: "owner-update",
          action: "update",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          check: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["id", "owner_id", "body"], deny: ["private_note"] },
        },
        {
          name: "owner-delete",
          action: "delete",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
        },
      ],
    },
  ],
};

describe("REST SELECT gateway", () => {
  test("publishes a minimal OpenAPI contract", async () => {
    const fixture = await createGatewayFixture();

    try {
      const response = await fixture.app.handle(new Request("http://gateway.local/openapi.json"));

      expect(response.status).toBe(200);
      expect((await response.json()).paths["/rest/v1/{table}"].get.responses["206"]).toBeDefined();
    } finally {
      fixture.adapter.close();
    }
  });

  test("executes policy-authorized select with exact count and item range", async () => {
    const fixture = await createGatewayFixture();

    try {
      const response = await fixture.app.handle(
        request("/rest/v1/notes?select=id,body&order=id.asc", {
          Range: "0-0",
          "Range-Unit": "items",
          Prefer: "count=exact",
        }),
      );

      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("0-0/1");
      expect(response.headers.get("range-unit")).toBe("items");
      expect(response.headers.get("x-correlation-id")).toBe(correlationId);
      expect(await response.json()).toEqual([{ id: 1, body: "Alice note" }]);
      expect(fixture.metrics).toEqual([
        { outcome: "success", status: 206, durationMs: 1, rowCount: 1 },
      ]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects cross-tenant headers, invalid query and rate limit without exposing stack traces", async () => {
    const fixture = await createGatewayFixture();

    try {
      const crossTenant = await fixture.app.handle(
        request("/rest/v1/notes?select=id", {}, { projectId: "project-other" }),
      );
      expect(crossTenant.status).toBe(403);
      expect(await crossTenant.json()).toEqual({
        error: {
          code: "forbidden",
          message: "The requested action is not permitted.",
          correlationId,
        },
      });

      const invalidQuery = await fixture.app.handle(request("/rest/v1/notes?unknown=eq.1"));
      expect(invalidQuery.status).toBe(400);
      expect((await invalidQuery.json()).error.code).toBe("validation");

      fixture.rateLimitAllowed = false;
      const limited = await fixture.app.handle(request("/rest/v1/notes?select=id"));
      expect(limited.status).toBe(429);
      expect((await limited.json()).error.code).toBe("quota");
    } finally {
      fixture.adapter.close();
    }
  });

  test("binds injection input as data and enforces query deadline, row and response caps", async () => {
    const fixture = await createGatewayFixture({ maxResponseBytes: 10 });

    try {
      const injection = encodeURIComponent("' OR 1=1; DROP TABLE notes; --");
      const injected = await fixture.app.handle(
        request(`/rest/v1/notes?select=id&body=eq.${injection}`),
      );
      expect(injected.status).toBe(200);
      expect(await injected.json()).toEqual([]);
      expect(fixture.adapter.execute({ sql: "SELECT COUNT(*) AS count FROM notes" }).rows).toEqual([
        { count: 2 },
      ]);

      fixture.shouldTimeout = true;
      const timedOut = await fixture.app.handle(request("/rest/v1/notes?select=id"));
      expect(timedOut.status).toBe(503);
      expect((await timedOut.json()).error.code).toBe("infrastructure");
      fixture.shouldTimeout = false;

      const rowCapped = await fixture.app.handle(request("/rest/v1/notes?select=id&limit=2"));
      expect(rowCapped.status).toBe(429);

      const byteCapped = await fixture.app.handle(request("/rest/v1/notes?select=id,body"));
      expect(byteCapped.status).toBe(413);
    } finally {
      fixture.adapter.close();
    }
  });

  test("sustains a small concurrent read smoke load with isolated results", async () => {
    const fixture = await createGatewayFixture({ maxResponseBytes: 1_000, maxRows: 10 });

    try {
      const responses = await Promise.all(
        Array.from({ length: 25 }, () =>
          fixture.app.handle(request("/rest/v1/notes?select=id,body")),
        ),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
        Array.from({ length: 25 }, () => [{ id: 1, body: "Alice note" }]),
      );
      expect(fixture.metrics.filter((metric) => metric.outcome === "success")).toHaveLength(25);
    } finally {
      fixture.adapter.close();
    }
  });
});

describe("REST mutation gateway", () => {
  test("inserts once across an idempotent retry and returns a policy-filtered representation", async () => {
    const fixture = await createGatewayFixture();
    const headers = {
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "Idempotency-Key": "insert-note-retry-0001",
    };

    try {
      const first = await fixture.app.handle(
        request("/rest/v1/notes", headers, {}, "POST", {
          id: 3,
          owner_id: "alice",
          body: "Created",
        }),
      );
      const second = await fixture.app.handle(
        request("/rest/v1/notes", headers, {}, "POST", {
          id: 3,
          owner_id: "alice",
          body: "Created",
        }),
      );

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(await first.json()).toEqual([{ id: 3, body: "Created" }]);
      expect(await second.json()).toEqual([{ id: 3, body: "Created" }]);
      expect(
        fixture.adapter.execute({ sql: "SELECT COUNT(*) AS count FROM notes WHERE id = 3" }).rows,
      ).toEqual([{ count: 1 }]);
      const changes = readChangefeed(fixture.adapter, {
        tenant: context("alice").tenant,
        afterCursor: 0,
        limit: 10,
      }).events;
      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual(
        expect.objectContaining({
          operation: "INSERT",
          table: "notes",
          oldRecord: null,
          record: { id: 3, body: "Created" },
        }),
      );
    } finally {
      fixture.adapter.close();
    }
  });

  test("checks old and new rows, rejects mass assignment and blocks unbounded writes", async () => {
    const fixture = await createGatewayFixture();

    try {
      const crossTenant = await fixture.app.handle(
        request(
          "/rest/v1/notes",
          { "Content-Type": "application/json", "Idempotency-Key": "cross-tenant-0001" },
          {},
          "POST",
          { id: 3, owner_id: "bob", body: "Denied" },
        ),
      );
      const massAssignment = await fixture.app.handle(
        request(
          "/rest/v1/notes?id=eq.1",
          { "Content-Type": "application/json", "Idempotency-Key": "private-field-0001" },
          {},
          "PATCH",
          { private_note: "bypass" },
        ),
      );
      const unboundedUpdate = await fixture.app.handle(
        request(
          "/rest/v1/notes",
          { "Content-Type": "application/json", "Idempotency-Key": "unbounded-patch-01" },
          {},
          "PATCH",
          { body: "all rows" },
        ),
      );
      const unboundedDelete = await fixture.app.handle(
        request("/rest/v1/notes", { "Idempotency-Key": "unbounded-delete1" }, {}, "DELETE"),
      );

      expect(crossTenant.status).toBe(403);
      expect(massAssignment.status).toBe(403);
      expect(unboundedUpdate.status).toBe(403);
      expect(unboundedDelete.status).toBe(403);
      expect(
        fixture.adapter.execute({ sql: "SELECT private_note FROM notes WHERE id = 1" }).rows,
      ).toEqual([{ private_note: "alice-secret" }]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("performs primary-key upsert and rejects idempotency-key reuse with changed input", async () => {
    const fixture = await createGatewayFixture();
    const headers = {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates, return=representation",
      "Idempotency-Key": "upsert-note-conflict1",
    };

    try {
      const response = await fixture.app.handle(
        request("/rest/v1/notes", headers, {}, "POST", {
          id: 1,
          owner_id: "alice",
          body: "Merged",
        }),
      );
      const reused = await fixture.app.handle(
        request("/rest/v1/notes", headers, {}, "POST", {
          id: 1,
          owner_id: "alice",
          body: "Different",
        }),
      );

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual([{ id: 1, body: "Merged" }]);
      expect(reused.status).toBe(409);
      expect(fixture.adapter.execute({ sql: "SELECT body FROM notes WHERE id = 1" }).rows).toEqual([
        { body: "Merged" },
      ]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rolls back a bulk transaction when a later row violates policy", async () => {
    const fixture = await createGatewayFixture({ bulkCapability: true, maxRows: 2 });

    try {
      const response = await fixture.app.handle(
        request(
          "/rest/v1/notes",
          {
            "Content-Type": "application/json",
            "Idempotency-Key": "bulk-rollback-test1",
          },
          {},
          "POST",
          [
            { id: 3, owner_id: "alice", body: "Would rollback" },
            { id: 4, owner_id: "bob", body: "Denied" },
          ],
        ),
      );

      expect(response.status).toBe(403);
      expect(
        fixture.adapter.execute({ sql: "SELECT id FROM notes WHERE id IN (3, 4)" }).rows,
      ).toEqual([]);
      expect(
        readChangefeed(fixture.adapter, {
          tenant: context("alice", true).tenant,
          afterCursor: 0,
          limit: 10,
        }).events,
      ).toEqual([]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("journals successful bulk rows in transaction order", async () => {
    const fixture = await createGatewayFixture({ bulkCapability: true, maxRows: 2 });

    try {
      const response = await fixture.app.handle(
        request(
          "/rest/v1/notes",
          {
            "Content-Type": "application/json",
            "Idempotency-Key": "bulk-changefeed-test1",
          },
          {},
          "POST",
          [
            { id: 3, owner_id: "alice", body: "First" },
            { id: 4, owner_id: "alice", body: "Second" },
          ],
        ),
      );

      expect(response.status).toBe(204);
      const events = readChangefeed(fixture.adapter, {
        tenant: context("alice", true).tenant,
        afterCursor: 0,
        limit: 10,
      }).events;
      expect(events.map((event) => event.record?.id)).toEqual([3, 4]);
      expect(events.map((event) => event.transaction.sequence)).toEqual([1, 2]);
      expect(new Set(events.map((event) => event.transaction.id)).size).toBe(1);
    } finally {
      fixture.adapter.close();
    }
  });
});

const correlationId = "018e6c28-0000-7000-8000-000000000001";

async function createGatewayFixture(
  limits: Partial<
    Readonly<{
      maxRows: number;
      maxResponseBytes: number;
      queryTimeoutMs: number;
      bulkCapability: boolean;
    }>
  > = {},
): Promise<{
  adapter: StorageAdapter;
  app: ReturnType<typeof createGatewayApp>;
  metrics: GatewayMetric[];
  rateLimitAllowed: boolean;
  shouldTimeout: boolean;
}> {
  const { bulkCapability = false, ...gatewayLimits } = limits;
  const adapter = await createTemporaryAdapter();
  adapter.execute({
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL, private_note TEXT)",
  });
  adapter.execute({
    sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
    parameters: [1, "alice", "Alice note", "alice-secret"],
  });
  adapter.execute({
    sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
    parameters: [2, "bob", "Bob note", "bob-secret"],
  });

  const fixture = {
    adapter,
    metrics: [] as GatewayMetric[],
    rateLimitAllowed: true,
    shouldTimeout: false,
  };
  const executor: RestQueryExecutor = {
    execute<Row extends Record<string, StorageValue>>(
      statement: StorageStatement,
      timeoutMs: number,
    ) {
      if (timeoutMs !== 25 || fixture.shouldTimeout) {
        throw new RestQueryTimeoutError();
      }
      return adapter.execute<Row>(statement);
    },
  };
  const tenantContext = context("alice", bulkCapability);
  const objectDirectory = await mkdtemp(join(tmpdir(), "mekka-gateway-objects-"));
  temporaryDirectories.push(objectDirectory);
  const objectProvider = createLocalObjectProvider(objectDirectory);
  let tick = 1_000_000;
  const now = () => tick++;
  const objectStorage = createObjectStorageCore({
    metadata: adapter,
    provider: objectProvider,
    policy: { authorize: () => true },
    now,
    signedReadGrants: {
      current: {
        id: "gateway-test",
        secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      },
    },
  });
  await objectStorage.createBucket(tenantContext, { name: "assets" });
  const project = {
    tenant: tenantContext.tenant,
    storage: adapter,
    objectStorage,
    executor,
    policies,
    realtimeChannels: [],
  };
  const app = createGatewayApp({
    authenticate: (request) => {
      if (request.headers.get("authorization") !== "Bearer test-token") {
        throw new ProtocolError("auth");
      }
      return tenantContext;
    },
    resolveProject: () => project,
    resolveProjectByTenant: () => project,
    authenticateRealtimeToken: (token) => {
      if (token !== "gateway-realtime-token") {
        throw new ProtocolError("auth");
      }
      return { context: tenantContext, expiresAt: 4_000_000_000 };
    },
    resolveRealtimeProject: () => project,
    consumeRateLimit: () => fixture.rateLimitAllowed,
    consumeSignedRateLimit: () => fixture.rateLimitAllowed,
    storagePublicOrigin: "https://storage.example.test",
    recordMetric: (metric) => fixture.metrics.push(metric),
    recordStorageAudit: () => undefined,
    now,
    limits: { maxRows: 1, maxResponseBytes: 1_000, queryTimeoutMs: 25, ...gatewayLimits },
  });

  return Object.assign(fixture, { app });
}

function context(actorId: string, bulkCapability = false): TenantContext {
  return createTenantContext({
    tenant: {
      organizationId: "org-main",
      projectId: "project-main",
      environmentId: "environment-main",
      branchId: "branch-main",
      generation: 1,
    },
    actor: { kind: "user", id: actorId },
    capabilities: bulkCapability
      ? [
          {
            id: "bulk-capability",
            tenant: {
              organizationId: "org-main",
              projectId: "project-main",
              environmentId: "environment-main",
              branchId: "branch-main",
              generation: 1,
            },
            actions: ["data:bulk"],
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
        ]
      : [],
    correlationId,
  });
}

function request(
  path: string,
  extraHeaders: Record<string, string> = {},
  tenant: Partial<Readonly<{ projectId: string }>> = {},
  method = "GET",
  body?: unknown,
): Request {
  return new Request(`http://gateway.local${path}`, {
    headers: {
      authorization: "Bearer test-token",
      [tenantHeaders.organizationId]: "org-main",
      [tenantHeaders.projectId]: tenant.projectId ?? "project-main",
      [tenantHeaders.environmentId]: "environment-main",
      [tenantHeaders.branchId]: "branch-main",
      [tenantHeaders.generation]: "1",
      [tenantHeaders.correlationId]: correlationId,
      ...extraHeaders,
    },
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
