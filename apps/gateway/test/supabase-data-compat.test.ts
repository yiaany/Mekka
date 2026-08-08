import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PolicyDocument, policyFormatVersion } from "@mekka/policy-engine";
import { createTenantContext, ProtocolError, tenantHeaders } from "@mekka/protocol";
import {
  createLocalObjectProvider,
  createObjectStorageCore,
  openStorageAdapter,
  type StorageAdapter,
  type StorageStatement,
  type StorageValue,
} from "@mekka/storage-core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createGatewayApp, type RestQueryExecutor } from "../src/app";

const temporaryDirectories: string[] = [];
const apiKey = "mekka_public_compatibility_key_0000000000000001";

afterEach(async () => {
  Bun.gc(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
}, 15_000);

describe("supabase-js Data API compatibility", () => {
  test("authenticates before validating Supabase request headers", async () => {
    const fixture = await createFixture();
    try {
      const response = await fixture.app.handle(
        new Request("http://gateway.local/rest/v1/notes?select=id", {
          headers: {
            apikey: "invalid-key",
            authorization: "Bearer invalid-key",
            accept: "text/plain",
          },
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "MEKKA_AUTH" });
    } finally {
      fixture.adapter.close();
    }
  });

  test("executes policy-scoped select, filters, order, range and exact count by URL and key", async () => {
    const fixture = await createFixture();
    try {
      const result = await fixture.client
        .from("notes")
        .select("id,body", { count: "exact" })
        .gte("id", 1)
        .in("id", [1, 2])
        .order("id", { ascending: false })
        .range(0, 0);

      expect(result).toMatchObject({
        data: [{ id: 1, body: "Alice note" }],
        error: null,
        count: 1,
        status: 200,
      });
      expect(JSON.stringify(result.data)).not.toContain("alice-secret");

      const rawHead = await fixture.app.handle(
        new Request("http://gateway.local/rest/v1/notes?select=*", {
          method: "HEAD",
          headers: { apikey: apiKey, authorization: `Bearer ${apiKey}`, prefer: "count=exact" },
        }),
      );
      expect({ status: rawHead.status, body: await rawHead.text() }).toEqual({
        status: 200,
        body: "",
      });
      const head = await fixture.client.from("notes").select("*", { count: "exact", head: true });
      expect(head).toMatchObject({ data: null, error: null, count: 1, status: 200 });
    } finally {
      fixture.adapter.close();
    }
  });

  test("supports insert, update, delete and primary-key upsert return modes", async () => {
    const fixture = await createFixture();
    try {
      const inserted = await fixture.client
        .from("notes")
        .insert({ id: 3, owner_id: "alice", body: "Created" }, { count: "exact" })
        .select("id,body");
      expect(inserted).toMatchObject({
        data: [{ id: 3, body: "Created" }],
        error: null,
        count: 1,
        status: 201,
      });

      const updated = await fixture.client
        .from("notes")
        .update({ body: "Updated" }, { count: "exact" })
        .eq("id", 3)
        .select("id,body");
      expect(updated).toMatchObject({
        data: [{ id: 3, body: "Updated" }],
        error: null,
        count: 1,
        status: 200,
      });

      const upserted = await fixture.client
        .from("notes")
        .upsert({ id: 3, owner_id: "alice", body: "Merged" }, { count: "exact" })
        .select("id,body");
      expect(upserted).toMatchObject({
        data: [{ id: 3, body: "Merged" }],
        error: null,
        count: 1,
        status: 201,
      });

      const primaryKeyOnly = await fixture.client.from("notes").upsert({ id: 3 }).select("id");
      expect(primaryKeyOnly).toMatchObject({ data: [{ id: 3 }], error: null, status: 201 });

      const deleted = await fixture.client
        .from("notes")
        .delete({ count: "exact" })
        .eq("id", 3)
        .select("id");
      expect(deleted).toMatchObject({
        data: [{ id: 3 }],
        error: null,
        count: 1,
        status: 200,
      });
    } finally {
      fixture.adapter.close();
    }
  });

  test("supports uniform atomic bulk insert and preserves policy enforcement", async () => {
    const fixture = await createFixture();
    try {
      const inserted = await fixture.client
        .from("notes")
        .insert([
          { id: 3, owner_id: "alice", body: "First" },
          { id: 4, owner_id: "alice", body: "Second" },
        ])
        .select("id,body");
      expect(inserted.error).toBeNull();
      expect(inserted.data).toEqual([
        { id: 3, body: "First" },
        { id: 4, body: "Second" },
      ]);

      const denied = await fixture.client.from("notes").insert([
        { id: 5, owner_id: "alice", body: "Rollback" },
        { id: 6, owner_id: "bob", body: "Denied" },
      ]);
      expect(denied.error?.code).toBe("MEKKA_FORBIDDEN");
      expect(
        fixture.adapter.execute({ sql: "SELECT id FROM notes WHERE id IN (5, 6) ORDER BY id" })
          .rows,
      ).toEqual([]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("fails explicitly for non-primary conflict targets, defaults, singular media and typed deviations", async () => {
    const fixture = await createFixture();
    try {
      const conflictTarget = await fixture.client
        .from("notes")
        .upsert({ id: 3, owner_id: "alice", body: "Unsupported" }, { onConflict: "owner_id" });
      expect(conflictTarget.error?.code).toBe("MEKKA_UNSUPPORTED");

      const defaults = await fixture.client
        .from("notes")
        .insert({ id: 3, owner_id: "alice", body: "Unsupported" }, { defaultToNull: false });
      expect(defaults.error?.code).toBe("MEKKA_UNSUPPORTED");

      const singular = await fixture.client.from("notes").select("id").eq("id", 1).single();
      expect(singular.error?.code).toBe("MEKKA_UNSUPPORTED");

      const typed = await fixture.client
        .from("notes")
        .insert({ id: 3, owner_id: "alice", body: true });
      expect(typed.error?.code).toBe("MEKKA_VALIDATION");
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects wrong keys and partial or mismatched native tenant headers", async () => {
    const fixture = await createFixture();
    try {
      const wrongKey = clientFor(fixture.app, "wrong-key");
      const unauthenticated = await wrongKey.from("notes").select("id");
      expect(unauthenticated.error?.code).toBe("MEKKA_AUTH");

      const partialHeaders = clientFor(fixture.app, apiKey, {
        [tenantHeaders.organizationId]: "org-main",
      });
      const partial = await partialHeaders.from("notes").select("id");
      expect(partial.error?.code).toBe("MEKKA_VALIDATION");

      const mismatchedHeaders = clientFor(fixture.app, apiKey, {
        [tenantHeaders.organizationId]: "org-main",
        [tenantHeaders.projectId]: "project-other",
        [tenantHeaders.environmentId]: "environment-main",
        [tenantHeaders.branchId]: "branch-main",
        [tenantHeaders.generation]: "1",
      });
      const mismatched = await mismatchedHeaders.from("notes").select("id");
      expect(mismatched.error?.code).toBe("MEKKA_FORBIDDEN");
    } finally {
      fixture.adapter.close();
    }
  });
});

async function createFixture(): Promise<{
  adapter: StorageAdapter;
  app: ReturnType<typeof createGatewayApp>;
  client: SupabaseClient;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-supabase-data-"));
  const objectDirectory = await mkdtemp(join(tmpdir(), "mekka-supabase-objects-"));
  temporaryDirectories.push(directory, objectDirectory);
  const adapter = openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "data.sqlite"),
  });
  adapter.execute({
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, owner_id TEXT, body TEXT, private_note TEXT)",
  });
  adapter.execute({
    sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
    parameters: [1, "alice", "Alice note", "alice-secret"],
  });
  adapter.execute({
    sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
    parameters: [2, "bob", "Bob note", "bob-secret"],
  });

  const context = createTenantContext({
    tenant: {
      organizationId: "org-main",
      projectId: "project-main",
      environmentId: "environment-main",
      branchId: "branch-main",
      generation: 1,
    },
    actor: { kind: "user", id: "alice" },
    capabilities: [
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
    ],
    correlationId: "018e6c28-0000-7000-8000-000000000099",
  });
  const executor: RestQueryExecutor = {
    execute<Row extends Record<string, StorageValue>>(
      statement: StorageStatement,
      timeoutMs: number,
    ) {
      if (timeoutMs !== 25) throw new Error("Unexpected timeout.");
      return adapter.execute<Row>(statement);
    },
  };
  const objectStorage = createObjectStorageCore({
    metadata: adapter,
    provider: createLocalObjectProvider(objectDirectory),
    policy: { authorize: () => true },
    signedReadGrants: {
      current: {
        id: "compatibility-test",
        secret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      },
    },
  });
  const project = {
    tenant: context.tenant,
    storage: adapter,
    objectStorage,
    executor,
    policies,
    realtimeChannels: [],
  };
  const app = createGatewayApp({
    authenticate() {
      throw new ProtocolError("auth");
    },
    supabaseData: {
      authenticateApiKey(request) {
        if (
          request.headers.get("apikey") !== apiKey ||
          request.headers.get("authorization") !== `Bearer ${apiKey}`
        ) {
          throw new ProtocolError("auth");
        }
        return context;
      },
    },
    resolveProject: () => project,
    resolveProjectByTenant: () => project,
    authenticateRealtimeToken() {
      throw new ProtocolError("auth");
    },
    resolveRealtimeProject: () => project,
    consumeRateLimit: () => true,
    consumeSignedRateLimit: () => true,
    storagePublicOrigin: "https://storage.example.test",
    recordMetric() {},
    recordStorageAudit() {},
    limits: { maxRows: 100, maxResponseBytes: 100_000, queryTimeoutMs: 25 },
  });
  return { adapter, app, client: clientFor(app, apiKey) };
}

function clientFor(
  app: ReturnType<typeof createGatewayApp>,
  key: string,
  headers: Record<string, string> = {},
): SupabaseClient {
  return createClient("http://gateway.local", key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      headers,
      fetch: async (input, init) => await app.handle(new Request(input, init)),
    },
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
          fields: { allow: ["id", "body"], deny: ["owner_id", "private_note"] },
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

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 99) throw error;
      Bun.gc(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}
