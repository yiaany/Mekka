import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProtocolError,
  createTenantContext,
  tenantHeaders,
  type TenantContext,
} from "@mekka/protocol";
import { createSchemaManifestCache } from "@mekka/schema-manifest";
import { createStudioDomainClient } from "@mekka/studio-domain-sdk";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import { createSqliteMetaApp, type SqliteMetaAuditEvent } from "../src/app";

const temporaryDirectories: string[] = [];
const correlationId = "018e6c28-0000-7000-8000-000000000001";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function createFixture(
  actions: readonly string[] = ["schema:manage"],
  onAudit?: (event: SqliteMetaAuditEvent) => void,
): Promise<{
  adapter: StorageAdapter;
  app: ReturnType<typeof createSqliteMetaApp>;
  audits: SqliteMetaAuditEvent[];
  context: TenantContext;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-sqlite-meta-"));
  temporaryDirectories.push(directory);
  const adapter = openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "project.sqlite"),
  });
  const audits: SqliteMetaAuditEvent[] = [];
  const context = createContext(actions);
  const app = createSqliteMetaApp({
    authenticate: (request) => {
      if (request.headers.get("authorization") !== "Bearer meta-token") {
        throw new ProtocolError("auth");
      }
      return context;
    },
    resolveProject: () => ({
      tenant: context.tenant,
      storage: adapter,
      schemaCache: createSchemaManifestCache(adapter),
    }),
    recordAudit: (event) => {
      onAudit?.(event);
      audits.push(event);
    },
    checkpointDirectory: directory,
    now: () => 1,
  });
  return { adapter, app, audits, context };
}

describe("sqlite-meta management API", () => {
  test("creates, lists and evolves stable table, column and index DTOs through migrations", async () => {
    const fixture = await createFixture();
    try {
      const initial = await fixture.app.handle(request("/tables"));
      const initialHash = schemaHash(fixture.adapter);
      const created = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "notes",
            expectedSchemaHash: initialHash,
            columns: [
              { name: "id", type: "INTEGER", primaryKey: true },
              { name: "body", type: "TEXT", nullable: false },
            ],
          },
          "create-table-idemp-01",
        ),
      );
      const added = await fixture.app.handle(
        request(
          "/columns",
          "POST",
          {
            table: "notes",
            expectedSchemaHash: schemaHash(fixture.adapter),
            name: "status",
            type: "TEXT",
          },
          "add-column-idemp-01",
        ),
      );
      const renamed = await fixture.app.handle(
        request(
          "/columns/notes/status",
          "PATCH",
          {
            name: "state",
            expectedSchemaHash: schemaHash(fixture.adapter),
          },
          "rename-column-idem1",
        ),
      );
      const index = await fixture.app.handle(
        request(
          "/indexes",
          "POST",
          {
            table: "notes",
            name: "notes_state_idx",
            columns: ["state"],
            expectedSchemaHash: schemaHash(fixture.adapter),
          },
          "create-index-idemp1",
        ),
      );

      expect(initial.status).toBe(200);
      const health = await fixture.app.handle(request("/schema/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        status: "ok",
        formatVersion: 1,
        schemaHash: schemaHash(fixture.adapter),
      });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({
        migrationSql:
          'CREATE TABLE "notes" ("id" INTEGER NOT NULL, "body" TEXT NOT NULL, PRIMARY KEY ("id"))',
        checkpointId: null,
        resource: {
          name: "notes",
          primaryKey: ["id"],
          columns: [
            { name: "id", type: "INTEGER", nullable: false, primaryKeyPosition: 1 },
            { name: "body", type: "TEXT", nullable: false },
          ],
        },
      });
      expect(
        ((await added.json()) as { resource: { columns: readonly { name: string }[] } }).resource
          .columns,
      ).toContainEqual(expect.objectContaining({ name: "status" }));
      expect(
        ((await renamed.json()) as { resource: { columns: readonly { name: string }[] } }).resource
          .columns,
      ).toContainEqual(expect.objectContaining({ name: "state" }));
      expect(await index.json()).toEqual({
        migrationSql: 'CREATE INDEX "notes_state_idx" ON "notes" ("state")',
        checkpointId: null,
        resource: {
          name: "notes_state_idx",
          table: "notes",
          unique: false,
          columns: ["state"],
        },
      });
      const studioClient = createStudioDomainClient({
        baseUrl: "http://sqlite-meta.local",
        tenant: fixture.context.tenant,
        getCredential: () => ({ kind: "session", token: "meta-token" }),
        fetch: (input, init) => fixture.app.handle(new Request(input, init)),
      });
      expect((await studioClient.listTables()).tables.map((table) => table.name)).toEqual([
        "notes",
      ]);
      expect(fixture.audits).toHaveLength(4);
      expect(
        fixture.adapter.execute({ sql: "SELECT COUNT(*) AS count FROM _mekka_migrations" }).rows,
      ).toEqual([{ count: 4 }]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("permits read-only schema inspection but denies schema mutation", async () => {
    const fixture = await createFixture();
    try {
      const readOnlyContext = createContext(["schema:read"]);
      const readOnlyApp = createSqliteMetaApp({
        authenticate: () => readOnlyContext,
        resolveProject: () => ({ tenant: readOnlyContext.tenant, storage: fixture.adapter }),
        recordAudit: () => undefined,
        checkpointDirectory: temporaryDirectories.at(-1) ?? tmpdir(),
        now: () => 1,
      });

      expect((await readOnlyApp.handle(request("/tables"))).status).toBe(200);
      expect((await readOnlyApp.handle(request("/schema/health"))).status).toBe(200);
      const mutation = await readOnlyApp.handle(
        request(
          "/tables",
          "POST",
          {
            name: "denied",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER" }],
          },
          "read-only-denied-id",
        ),
      );
      expect(mutation.status).toBe(403);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects stale schema, unsupported PostgreSQL options and identifier injection", async () => {
    const fixture = await createFixture();
    try {
      const hash = schemaHash(fixture.adapter);
      const created = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "accounts",
            expectedSchemaHash: hash,
            columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
          },
          "create-accounts-idemp",
        ),
      );
      const stale = await fixture.app.handle(
        request(
          "/columns",
          "POST",
          {
            table: "accounts",
            expectedSchemaHash: hash,
            name: "email",
            type: "TEXT",
          },
          "stale-column-idemp1",
        ),
      );
      const unsupported = await fixture.app.handle(
        request(
          "/columns",
          "POST",
          {
            table: "accounts",
            expectedSchemaHash: schemaHash(fixture.adapter),
            name: "user_id",
            type: "uuid",
          },
          "postgres-option-idem",
        ),
      );
      const injection = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "pwned;drop",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER" }],
          },
          "injection-meta-idemp",
        ),
      );

      expect(created.status).toBe(200);
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe("conflict");
      expect(unsupported.status).toBe(501);
      expect((await unsupported.json()).error.code).toBe("unsupported");
      expect(injection.status).toBe(400);
      expect(
        fixture.adapter.execute({
          sql: "SELECT name FROM sqlite_master WHERE name = ?",
          parameters: ["pwned"],
        }).rows,
      ).toEqual([]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("requires tenant capability and creates a checkpoint before destructive table deletion", async () => {
    const fixture = await createFixture();
    try {
      const unauthorized = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "forbidden",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER" }],
          },
          "forbidden-meta-idemp",
          { authorization: "Bearer wrong" },
        ),
      );
      const crossTenant = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "cross_tenant",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER" }],
          },
          "cross-tenant-meta-id",
          { [tenantHeaders.projectId]: "project-other" },
        ),
      );
      const created = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "temporary",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER" }],
          },
          "create-temporary-idem",
        ),
      );
      const deleted = await fixture.app.handle(
        request(
          `/tables/temporary?expected_schema_hash=${schemaHash(fixture.adapter)}`,
          "DELETE",
          undefined,
          "delete-temporary-idem",
        ),
      );

      expect(unauthorized.status).toBe(401);
      expect(crossTenant.status).toBe(403);
      expect(created.status).toBe(200);
      expect(deleted.status).toBe(200);
      expect((await deleted.json()).resource.name).toBe("temporary");
      expect(fixture.audits.at(-1)).toMatchObject({
        action: "delete_table",
        checkpointId: expect.any(String),
      });
    } finally {
      fixture.adapter.close();
    }
  });

  test("paginates and mutates rows through manifest-backed identifiers", async () => {
    const fixture = await createFixture(["schema:manage", "data:read", "data:write"]);
    try {
      await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "notes",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [
              { name: "id", type: "INTEGER", primaryKey: true },
              { name: "body", type: "TEXT" },
            ],
          },
          "create-row-notes-01",
        ),
      );
      const inserted = await fixture.app.handle(
        request("/rows/notes", "POST", { values: { id: 1, body: "first" } }, "insert-row-notes01"),
      );
      const listed = await fixture.app.handle(
        request("/rows/notes?limit=1&offset=0&filter_column=body&filter_value=first"),
      );
      const updated = await fixture.app.handle(
        request(
          "/rows/notes",
          "PATCH",
          { key: { column: "id", value: 1 }, values: { body: "updated" } },
          "update-row-notes01",
        ),
      );
      const deleted = await fixture.app.handle(
        request("/rows/notes?key_column=id&key_value=1", "DELETE", undefined, "delete-row-notes01"),
      );

      expect(await inserted.json()).toMatchObject({ changes: 1 });
      expect(await listed.json()).toEqual({
        rows: [{ id: 1, body: "first" }],
        totalCount: 1,
        limit: 1,
        offset: 0,
      });
      expect(await updated.json()).toMatchObject({ changes: 1 });
      expect(await deleted.json()).toMatchObject({ changes: 1 });
      expect(fixture.audits.map((event) => event.action)).toContain("create_row");
      expect(fixture.audits.at(-1)).toMatchObject({
        action: "delete_row",
        statementHash: expect.any(String),
      });
    } finally {
      fixture.adapter.close();
    }
  });

  test("commits row idempotency and audit intent atomically, then replays safely", async () => {
    let auditAvailable = true;
    const fixture = await createFixture(["schema:manage", "data:write"], () => {
      if (!auditAvailable) throw new Error("audit sink unavailable");
    });
    try {
      const table = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "notes",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
          },
          "ledger-create-notes-001",
        ),
      );
      auditAvailable = false;
      const first = await fixture.app.handle(
        request("/rows/notes", "POST", { values: { id: 1 } }, "ledger-row-insert-001"),
      );
      const replay = await fixture.app.handle(
        request("/rows/notes", "POST", { values: { id: 1 } }, "ledger-row-insert-001"),
      );
      const conflict = await fixture.app.handle(
        request("/rows/notes", "POST", { values: { id: 2 } }, "ledger-row-insert-001"),
      );

      expect(table.status).toBe(200);
      expect(first.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(await first.clone().json());
      expect(conflict.status).toBe(409);
      expect(
        fixture.adapter.execute<{ count: number }>({ sql: 'SELECT COUNT(*) AS count FROM "notes"' })
          .rows,
      ).toEqual([{ count: 1 }]);
      expect(
        fixture.adapter.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM _mekka_audit_outbox",
        }).rows,
      ).toEqual([{ count: 1 }]);

      auditAvailable = true;
      const delivered = await fixture.app.handle(
        request("/rows/notes", "POST", { values: { id: 1 } }, "ledger-row-insert-001"),
      );
      expect(delivered.status).toBe(200);
      expect(fixture.audits).toContainEqual(expect.objectContaining({ action: "create_row" }));
      expect(
        fixture.adapter.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM _mekka_audit_outbox",
        }).rows,
      ).toEqual([{ count: 0 }]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("keeps SQL read-only by default and blocks multi-statement and dangerous SQL", async () => {
    const fixture = await createFixture(["schema:manage", "data:read"]);
    try {
      const read = await fixture.app.handle(
        request("/sql", "POST", { sql: "SELECT 1 AS value LIMIT 1" }, "sql-read-notes-001"),
      );
      const write = await fixture.app.handle(
        request("/sql", "POST", { sql: "DELETE FROM notes WHERE id = 1" }, "sql-write-notes01"),
      );
      const dangerous = await fixture.app.handle(
        request("/sql", "POST", { sql: "PRAGMA foreign_keys = OFF" }, "sql-danger-notes01"),
      );
      const multiStatement = await fixture.app.handle(
        request(
          "/sql",
          "POST",
          { sql: "SELECT 1 LIMIT 1; SELECT 2 LIMIT 1" },
          "sql-multi-notes001",
        ),
      );
      const table = await fixture.app.handle(
        request(
          "/tables",
          "POST",
          {
            name: "notes",
            expectedSchemaHash: schemaHash(fixture.adapter),
            columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
          },
          "sql-create-notes-001",
        ),
      );
      const join = await fixture.app.handle(
        request(
          "/sql",
          "POST",
          { sql: "SELECT notes.id FROM notes JOIN sqlite_sequence ON true LIMIT 1" },
          "sql-join-notes-001",
        ),
      );

      expect(read.status).toBe(200);
      expect(table.status).toBe(200);
      expect(await read.json()).toEqual({ rows: [{ value: 1 }], changes: 0 });
      expect(write.status).toBe(403);
      expect(dangerous.status).toBe(501);
      expect(multiStatement.status).toBe(400);
      expect(join.status).toBe(501);
      expect(JSON.stringify(fixture.audits)).not.toContain("SELECT 1 AS value");
    } finally {
      fixture.adapter.close();
    }
  });
});

function createContext(actions: readonly string[] = ["schema:manage"]): TenantContext {
  return createTenantContext({
    tenant: {
      organizationId: "org-main",
      projectId: "project-main",
      environmentId: "environment-main",
      branchId: "branch-main",
      generation: 1,
    },
    actor: { kind: "service", id: "studio-service" },
    capabilities: [
      {
        id: "schema-manage-capability",
        tenant: {
          organizationId: "org-main",
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
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`http://sqlite-meta.local${path}`, {
    method,
    headers: {
      authorization: "Bearer meta-token",
      [tenantHeaders.organizationId]: "org-main",
      [tenantHeaders.projectId]: "project-main",
      [tenantHeaders.environmentId]: "environment-main",
      [tenantHeaders.branchId]: "branch-main",
      [tenantHeaders.generation]: "1",
      [tenantHeaders.correlationId]: correlationId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
