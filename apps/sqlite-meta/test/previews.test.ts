import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineError } from "@mekka/engine-core";
import { openSqliteEngine, type Engine } from "@mekka/engine-core";
import {
  createTenantContext,
  ProtocolError,
  type TenantContext,
  tenantHeaders,
} from "@mekka/protocol";
import { createAsyncSchemaManifestCache, createSchemaManifestCache } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import { createSqliteMetaApp, type SqliteMetaAuditEvent } from "../src/app";
import { createStubAdapter, type StubAdapter, tursoDatabaseTokenPrefix } from "./turso-stub";

const temporaryDirectories: string[] = [];
const testEngines: Engine[] = [];
const correlationId = "018e6c28-0000-7000-8000-000000000001";

afterEach(async () => {
  await Promise.all(testEngines.splice(0).map((engine) => engine.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
          return;
        } catch {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }
    }),
  );
});

async function createFixture(
  actions: readonly string[] = ["preview:manage", "schema:manage"],
  overrides: { adapter?: StubAdapter; audits?: SqliteMetaAuditEvent[] } = {},
): Promise<{
  adapter: StorageAdapter;
  app: ReturnType<typeof createSqliteMetaApp>;
  audits: SqliteMetaAuditEvent[];
  context: TenantContext;
  previews: StubAdapter;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-sqlite-meta-previews-"));
  temporaryDirectories.push(directory);
  const storage = openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "project.sqlite"),
  });
  const engine = openSqliteEngine({
    databaseDirectory: directory,
    databasePath: join(directory, "project.sqlite"),
  });
  testEngines.push(engine);
  const audits: SqliteMetaAuditEvent[] = [];
  const context = createContext(actions);
  const previews = overrides.adapter ?? createStubAdapter();
  const app = createSqliteMetaApp({
    authenticate: (request) => {
      if (request.headers.get("authorization") !== "Bearer meta-token") {
        throw new ProtocolError("auth");
      }
      return context;
    },
    resolveProject: () => ({
      tenant: context.tenant,
      engine,
      localStorage: storage,
      schemaCache: createAsyncSchemaManifestCache(engine),
    }),
    recordAudit: (event) => audits.push(event),
    checkpointDirectory: directory,
    previews: { adapter: previews },
    now: () => 1,
  });
  return { adapter: storage, app, audits, context, previews };
}

describe("previews capability", () => {
  test("reports unsupported when the provider is not configured, and keeps the main path working", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-sqlite-meta-previews-"));
    temporaryDirectories.push(directory);
    const storage = openStorageAdapter({
      databaseDirectory: directory,
      databasePath: join(directory, "project.sqlite"),
    });
    const context = createContext(["preview:manage", "schema:manage"]);
    const engine = openSqliteEngine({
      databaseDirectory: directory,
      databasePath: join(directory, "project.sqlite"),
    });
    testEngines.push(engine);
    const app = createSqliteMetaApp({
      authenticate: () => context,
      resolveProject: () => ({ tenant: context.tenant, engine, localStorage: storage }),
      recordAudit: () => undefined,
      checkpointDirectory: directory,
    });
    try {
      const created = await app.handle(request("/previews", "POST"));
      expect(created.status).toBe(501);
      expect(await created.json()).toMatchObject({ error: { code: "unsupported" } });
      const tables = await app.handle(request("/tables"));
      expect(tables.status).toBe(200);
    } finally {
      storage.close();
    }
  });
});

describe("preview lifecycle", () => {
  test("creates a preview and never exposes the database token", async () => {
    const fixture = await createFixture();
    try {
      const created = await fixture.app.handle(request("/previews", "POST"));
      expect(created.status).toBe(200);
      const record = (await created.json()) as Record<string, unknown>;
      expect(record.state).toBe("ready");
      expect(record.resourceId).toMatch(/^id-mekka-/);
      expect(record.hostname).toMatch(/\.example\.turso\.io$/);
      expect(record.name).toMatch(/^mekka-[a-z0-9-]{0,63}$/);
      expect(JSON.stringify(record)).not.toContain(tursoDatabaseTokenPrefix);
      expect(fixture.previews.providerDatabases()).toContain(record.name);
      expect(fixture.audits.map((event) => event.action)).toContain("preview_create");
    } finally {
      fixture.adapter.close();
    }
  });

  test("replays the same preview on repeated creates", async () => {
    const fixture = await createFixture();
    try {
      const first = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
        createdAt: number;
      };
      const second = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
        createdAt: number;
      };
      expect(second.name).toBe(first.name);
      expect(second.createdAt).toBe(first.createdAt);
      expect(fixture.previews.createCalls()).toBe(1);
    } finally {
      fixture.adapter.close();
    }
  });

  test("records a failed state with a typed error code when the provider fails", async () => {
    const fixture = await createFixture();
    try {
      fixture.previews.setCreateFailure(
        new EngineError("ENGINE_UNAVAILABLE", "The provider is temporarily unavailable."),
      );
      const created = await fixture.app.handle(request("/previews", "POST"));
      expect(created.status).toBe(200);
      const record = (await created.json()) as Record<string, unknown>;
      expect(record.state).toBe("failed");
      expect(record.errorCode).toBe("ENGINE_UNAVAILABLE");
      expect(record.errorMessage).toBe("The branch provider is temporarily unavailable.");
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain("api.turso.tech");
      expect(serialized).not.toContain(tursoDatabaseTokenPrefix);
      expect(serialized).not.toContain("EngineError");
    } finally {
      fixture.adapter.close();
    }
  });

  test("lists previews in creation order", async () => {
    const fixture = await createFixture();
    try {
      await fixture.app.handle(request("/previews", "POST"));
      const list = await fixture.app.handle(request("/previews"));
      expect(list.status).toBe(200);
      const body = (await list.json()) as { previews?: unknown };
      expect(Array.isArray(body.previews)).toBe(false);
      const records = body as readonly Record<string, unknown>[];
      expect(records).toHaveLength(1);
      expect(records[0]?.state).toBe("ready");
      expect(JSON.stringify(body)).not.toContain(tursoDatabaseTokenPrefix);
    } finally {
      fixture.adapter.close();
    }
  });

  test("returns 404 for unknown previews on get, status and delete", async () => {
    const fixture = await createFixture();
    try {
      for (const path of ["/previews/not-a-preview", "/previews/not-a-preview/status"]) {
        const response = await fixture.app.handle(request(path));
        expect(response.status).toBe(404);
      }
      const deleted = await fixture.app.handle(request("/previews/not-a-preview", "DELETE"));
      expect(deleted.status).toBe(404);
      const promoted = await fixture.app.handle(
        request(
          "/previews/not-a-preview/promote",
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
        ),
      );
      expect(promoted.status).toBe(404);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects malformed preview names in routes", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.app.handle(request("/previews/INVALID/status"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    } finally {
      fixture.adapter.close();
    }
  });

  test("refreshes status to ready and detects a provider resource that disappeared", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const refreshed = await fixture.app.handle(request(`/previews/${created.name}/status`));
      expect((await refreshed.json()) as { state: string }).toMatchObject({ state: "ready" });

      fixture.previews.removeProviderResource(created.name);
      const afterRemoval = await fixture.app.handle(request(`/previews/${created.name}/status`));
      const record = (await afterRemoval.json()) as Record<string, unknown>;
      expect(record.state).toBe("failed");
      expect(record.errorCode).toBe("ENGINE_NOT_FOUND");
    } finally {
      fixture.adapter.close();
    }
  });

  test("deletes the provider resource and records a deleting state idempotently", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const deleted = await fixture.app.handle(
        request(`/previews/${created.name}`, "DELETE", undefined, "delete-key-0000000000001"),
      );
      expect(deleted.status).toBe(200);
      expect((await deleted.json()) as { state: string }).toMatchObject({ state: "deleting" });
      expect(fixture.previews.providerDatabases()).not.toContain(created.name);
      expect(fixture.audits.map((event) => event.action)).toContain("preview_delete");

      const replayed = await fixture.app.handle(
        request(`/previews/${created.name}`, "DELETE", undefined, "delete-key-0000000000002"),
      );
      expect((await replayed.json()) as { state: string }).toMatchObject({ state: "deleting" });
      expect(fixture.previews.deleteCalls()).toBe(1);
    } finally {
      fixture.adapter.close();
    }
  });

  test("does not recreate a preview while it is deleting", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      fixture.previews.setDeleteFailure(
        new EngineError("ENGINE_UNAVAILABLE", "The provider is temporarily unavailable."),
      );
      const deleted = await fixture.app.handle(
        request(`/previews/${created.name}`, "DELETE", undefined, "delete-key-0000000000001"),
      );
      expect(deleted.status).toBe(503);
      const recreated = await fixture.app.handle(request("/previews", "POST"));
      expect(recreated.status).toBe(409);
    } finally {
      fixture.adapter.close();
    }
  });
});

describe("promotion", () => {
  test("requires explicit confirmation", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const promoted = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: false },
          "promote-key-0000000000001",
        ),
      );
      expect(promoted.status).toBe(400);
      const missing = await fixture.app.handle(
        request(`/previews/${created.name}/promote`, "POST", {}, "promote-key-0000000000001"),
      );
      expect(missing.status).toBe(400);
    } finally {
      fixture.adapter.close();
    }
  });

  test("refuses to promote a preview that is not ready", async () => {
    const fixture = await createFixture();
    try {
      fixture.previews.setCreateFailure(new EngineError("ENGINE_FAILED", "boom"));
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const promoted = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
        ),
      );
      expect(promoted.status).toBe(409);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects promotion when the primary schema diverged since the preview was created", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const initialHash = schemaHash(fixture.adapter);
      const table = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "notes",
            expectedSchemaHash: initialHash,
            columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
          },
          "divergence-idemp-1",
        ),
      );
      expect(table.status).toBe(200);
      const promoted = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
        ),
      );
      expect(promoted.status).toBe(409);
      expect(await promoted.json()).toMatchObject({ error: { code: "conflict" } });
    } finally {
      fixture.adapter.close();
    }
  });

  test("promotes an in-sync preview once and replays under the same idempotency key", async () => {
    const fixture = await createFixture();
    try {
      const created = (await (await fixture.app.handle(request("/previews", "POST"))).json()) as {
        name: string;
      };
      const promoted = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
        ),
      );
      expect(promoted.status).toBe(200);
      const result = (await promoted.json()) as { promotedAt: number; schemaHash: string };
      expect(result.promotedAt).toBe(1);
      expect(result.schemaHash).toMatch(/^[a-f0-9]{64}$/);

      const replayed = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
        ),
      );
      expect((await replayed.json()) as { promotedAt: number }).toMatchObject({ promotedAt: 1 });

      const conflicting = await fixture.app.handle(
        request(
          `/previews/${created.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000002",
        ),
      );
      expect(conflicting.status).toBe(409);
      expect(fixture.audits.filter((event) => event.action === "preview_promote")).toHaveLength(1);
    } finally {
      fixture.adapter.close();
    }
  });
});

describe("cross-tenant isolation", () => {
  test("previews are scoped to the full tenant identity", async () => {
    const directoryA = await mkdtemp(join(tmpdir(), "mekka-sqlite-meta-previews-"));
    const directoryB = await mkdtemp(join(tmpdir(), "mekka-sqlite-meta-previews-"));
    temporaryDirectories.push(directoryA, directoryB);
    const previews = createStubAdapter();
    const contextA = createContext(["preview:manage"], "org-a");
    const contextB = createContext(["preview:manage"], "org-b");
    const storageA = openStorageAdapter({
      databaseDirectory: directoryA,
      databasePath: join(directoryA, "project.sqlite"),
    });
    const storageB = openStorageAdapter({
      databaseDirectory: directoryB,
      databasePath: join(directoryB, "project.sqlite"),
    });
    const engineA = openSqliteEngine({
      databaseDirectory: directoryA,
      databasePath: join(directoryA, "project.sqlite"),
    });
    const engineB = openSqliteEngine({
      databaseDirectory: directoryB,
      databasePath: join(directoryB, "project.sqlite"),
    });
    testEngines.push(engineA, engineB);
    const appA = createSqliteMetaApp({
      authenticate: () => contextA,
      resolveProject: () => ({ tenant: contextA.tenant, engine: engineA, localStorage: storageA }),
      recordAudit: () => undefined,
      checkpointDirectory: directoryA,
      previews: { adapter: previews },
      now: () => 1,
    });
    const appB = createSqliteMetaApp({
      authenticate: () => contextB,
      resolveProject: () => ({ tenant: contextB.tenant, engine: engineB, localStorage: storageB }),
      recordAudit: () => undefined,
      checkpointDirectory: directoryB,
      previews: { adapter: previews },
      now: () => 1,
    });
    try {
      const createdA = (await (
        await appA.handle(request("/previews", "POST", undefined, undefined, "org-a"))
      ).json()) as {
        name: string;
      };
      const createdB = (await (
        await appB.handle(request("/previews", "POST", undefined, undefined, "org-b"))
      ).json()) as { name: string };
      expect(createdA.name).not.toBe(createdB.name);

      const listB = (await (
        await appB.handle(request("/previews", "GET", undefined, undefined, "org-b"))
      ).json()) as { name: string }[];
      expect(listB).toHaveLength(1);
      expect(listB[0].name).toBe(createdB.name);

      const getB = await appB.handle(
        request(`/previews/${createdA.name}`, "GET", undefined, undefined, "org-b"),
      );
      expect(getB.status).toBe(404);
      const deleteB = await appB.handle(
        request(`/previews/${createdA.name}`, "DELETE", undefined, undefined, "org-b"),
      );
      expect(deleteB.status).toBe(404);
      const promoteB = await appB.handle(
        request(
          `/previews/${createdA.name}/promote`,
          "POST",
          { confirmed: true },
          "promote-key-0000000000001",
          "org-b",
        ),
      );
      expect(promoteB.status).toBe(404);

      const deleteA = await appA.handle(
        request(`/previews/${createdA.name}`, "DELETE", undefined, undefined, "org-a"),
      );
      expect(deleteA.status).toBe(200);
    } finally {
      storageA.close();
      storageB.close();
    }
  });
});

function createContext(
  actions: readonly string[] = ["preview:manage", "schema:manage"],
  organizationId = "org-main",
): TenantContext {
  return createTenantContext({
    tenant: {
      organizationId,
      projectId: "project-main",
      environmentId: "environment-main",
      branchId: "branch-main",
      generation: 1,
    },
    actor: { kind: "service", id: "studio-service" },
    capabilities: [
      {
        id: "preview-capability",
        tenant: {
          organizationId,
          projectId: "project-main",
          environmentId: "environment-main",
          branchId: "branch-main",
          generation: 1,
        },
        actions,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    ],
    correlationId,
  });
}

function schemaHash(adapter: StorageAdapter): string {
  return createSchemaManifestCache(adapter).get().hash;
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  idempotencyKey?: string,
  organizationId = "org-main",
): Request {
  return new Request(`http://sqlite-meta.local${path}`, {
    method,
    headers: {
      authorization: "Bearer meta-token",
      [tenantHeaders.organizationId]: organizationId,
      [tenantHeaders.projectId]: "project-main",
      [tenantHeaders.environmentId]: "environment-main",
      [tenantHeaders.branchId]: "branch-main",
      [tenantHeaders.generation]: "1",
      [tenantHeaders.correlationId]: correlationId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
