import { describe, expect, test } from "bun:test";
import { tenantHeaders } from "@mekka/protocol";
import {
  createStudioAuthAdminClient,
  createStudioDomainClient,
  createStudioOnboardingClient,
  createStudioPreviewClient,
  createStudioStorageClient,
  type StudioCredential,
  StudioDomainError,
} from "../src/index";

const tenant = {
  organizationId: "org-main",
  projectId: "project-main",
  environmentId: "environment-main",
  branchId: "branch-main",
  generation: 7,
};
const correlationId = "018e6c28-0000-7000-8000-000000000001";

describe("Studio Domain SDK", () => {
  test("manages Storage without provider credentials and resumes an interrupted upload", async () => {
    const requests: Request[] = [];
    const progressStates: string[] = [];
    let patchAttempts = 0;
    let authoritativeOffset = 0;
    const client = createStudioStorageClient({
      baseUrl: "http://studio.local/storage-admin/project-main",
      tenant,
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      getCsrfToken: () => "storage-csrf-token-value-001",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST" && request.url.endsWith("/buckets")) {
          return Response.json(
            { name: "documents", isPublic: false, createdAt: 1, updatedAt: 1 },
            { status: 201 },
          );
        }
        if (request.method === "POST" && request.url.includes("/resumable/")) {
          return new Response(null, {
            status: 201,
            headers: {
              location: "https://storage.example.test/storage/v1/resumable/upload-001",
              "upload-offset": "0",
            },
          });
        }
        if (request.method === "PATCH") {
          patchAttempts += 1;
          const offset = Number(request.headers.get("upload-offset"));
          const length = (await request.arrayBuffer()).byteLength;
          authoritativeOffset = offset + length;
          if (patchAttempts === 1) throw new Error("response lost after commit");
          return new Response(null, {
            status: 204,
            headers: { "upload-offset": String(authoritativeOffset) },
          });
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "upload-offset": String(authoritativeOffset) },
          });
        }
        if (request.url.includes("/objects?prefix=")) {
          return Response.json({
            objects: [
              {
                bucketName: "documents",
                path: "large.bin",
                size: 1024 * 1024 + 1,
                contentType: "application/octet-stream",
                checksumSha256: "a".repeat(64),
                version: "object-version-001",
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          });
        }
        return Response.json({ buckets: [] });
      },
    });

    const bucket = await client.createBucket("documents", "storage-bucket-create-001");
    const uploaded = await client.uploadObject(
      "documents",
      "large.bin",
      new Blob([new Uint8Array(1024 * 1024 + 1)]),
      {
        idempotencyKey: "storage-object-upload-001",
        onProgress: (progress) => progressStates.push(progress.state),
      },
    );

    expect(bucket).toEqual({ name: "documents", isPublic: false, createdAt: 1, updatedAt: 1 });
    expect(uploaded.path).toBe("large.bin");
    expect(progressStates).toContain("retrying");
    expect(progressStates.at(-1)).toBe("complete");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer session-token-value");
    expect(requests[0]?.headers.get("x-mekka-csrf-token")).toBe("storage-csrf-token-value-001");
    expect(requests.some((request) => request.headers.has("x-provider-credential"))).toBe(false);
  });

  test("manages Auth through a session-only tenant and CSRF contract without returning provider secrets", async () => {
    const requests: Request[] = [];
    const client = createStudioAuthAdminClient({
      baseUrl: "http://studio-backend.local/auth-admin/project-main",
      tenant,
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      getCsrfToken: () => "csrf-token-value-that-is-long-enough",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("/users?")) {
          return Response.json({
            users: [
              {
                id: "user-001",
                email: "member@example.test",
                name: "Member",
                emailVerified: true,
                createdAt: "2026-08-04T00:00:00.000Z",
                updatedAt: "2026-08-04T00:00:00.000Z",
                sessionCount: 1,
              },
            ],
            totalCount: 1,
            limit: 50,
            offset: 0,
          });
        }
        if (request.url.endsWith("/providers/google")) {
          return Response.json({
            enabled: true,
            clientIdConfigured: true,
            clientSecretConfigured: true,
            clientSecret: "must-not-leak",
          });
        }
        if (request.method === "DELETE") {
          return Response.json({ deleted: true, userId: "user-001" });
        }
        return Response.json({ revoked: true });
      },
    });

    const users = await client.listUsers();
    const provider = await client.updateProvider(
      "google",
      { enabled: true, clientId: "google-client", clientSecret: "google-secret" },
      "auth-provider-update-0001",
    );
    await client.revokeUser("user-001", "user-001", "auth-user-revoke-0001");
    expect(await client.deleteUser("user-001", "user-001", "auth-user-delete-0001")).toEqual({
      deleted: true,
      userId: "user-001",
    });

    expect(users.users[0]).toMatchObject({ email: "member@example.test", sessionCount: 1 });
    expect(provider).toEqual({
      provider: "google",
      enabled: true,
      clientIdConfigured: true,
      clientSecretConfigured: true,
    });
    expect(Object.keys(provider)).not.toContain("clientSecret");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer session-token-value");
    expect(requests[0]?.headers.get("x-mekka-csrf-token")).toBeNull();
    expect(requests[1]?.headers.get("x-mekka-csrf-token")).toBe(
      "csrf-token-value-that-is-long-enough",
    );
    expect(requests[0]?.headers.get(tenantHeaders.projectId)).toBe("project-main");
    expect(requests[1]?.headers.get("idempotency-key")).toBe("auth-provider-update-0001");
    expect(requests.at(-1)?.method).toBe("DELETE");
    expect(requests.at(-1)?.headers.get("x-mekka-csrf-token")).toBe(
      "csrf-token-value-that-is-long-enough",
    );
    expect(await requests.at(-1)?.json()).toEqual({ confirmation: "user-001" });
  });

  test.each([
    [{ message: "Unauthorized" }, 401, "auth"],
    [{ error: { message: "Forbidden" } }, 403, "forbidden"],
    [{ code: "conflict" }, 409, "conflict"],
    [{ error: { code: "validation" } }, 400, "validation"],
  ] as const)("parses safe Auth error shapes %#", async (body, status, code) => {
    const client = createStudioAuthAdminClient({
      baseUrl: "http://studio-backend.local/auth-admin/project-main",
      tenant,
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      getCsrfToken: () => "csrf-token-value-that-is-long-enough",
      fetch: async () => Response.json(body, { status }),
    });

    await expect(client.listUsers()).rejects.toMatchObject({ code, status });
    try {
      await client.listUsers();
    } catch (error) {
      expect((error as Error).message).not.toContain(JSON.stringify(body));
    }
  });

  test("maps sqlite-meta tables without exposing provider details and sends tenant/session context", async () => {
    let captured: Request | undefined;
    const client = createClient(async (input, init) => {
      captured = new Request(input, init);
      return Response.json([
        {
          name: "notes",
          columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKeyPosition: 1 }],
          primaryKey: ["id"],
          indexes: [{ name: "notes_idx", table: "notes", unique: false, columns: ["id"] }],
          rawPragma: "must-not-leak",
        },
      ]);
    });

    const result = await client.listTables();

    expect(result).toEqual({
      tables: [
        {
          id: "notes",
          name: "notes",
          namespace: "main",
          kind: "table",
          columnCount: 1,
          primaryKey: ["id"],
        },
      ],
      totalCount: 1,
    });
    expect(Object.keys(result.tables[0] ?? {})).toEqual([
      "id",
      "name",
      "namespace",
      "kind",
      "columnCount",
      "primaryKey",
    ]);
    expect(captured?.headers.get("authorization")).toBe("Bearer session-token-value");
    expect(captured?.headers.get(tenantHeaders.organizationId)).toBe("org-main");
    expect(captured?.headers.get(tenantHeaders.projectId)).toBe("project-main");
    expect(captured?.headers.get(tenantHeaders.environmentId)).toBe("environment-main");
    expect(captured?.headers.get(tenantHeaders.branchId)).toBe("branch-main");
    expect(captured?.headers.get(tenantHeaders.generation)).toBe("7");
  });

  test("supports schema health, filtering and deterministic pagination", async () => {
    const client = createClient(async (input) => {
      if (String(input).endsWith("/schema/health")) {
        return Response.json({
          status: "ok",
          formatVersion: 1,
          schemaVersion: 3,
          schemaHash: "a".repeat(64),
        });
      }
      return Response.json([
        { name: "zebra", columns: [], primaryKey: [], indexes: [] },
        { name: "alpha", columns: [], primaryKey: [], indexes: [] },
        { name: "alpine", columns: [], primaryKey: [], indexes: [] },
      ]);
    });

    expect(await client.getSchemaHealth()).toEqual({
      status: "ok",
      formatVersion: 1,
      schemaVersion: 3,
      schemaHash: "a".repeat(64),
    });
    expect(await client.listTables({ search: "al", limit: 1, page: 1 })).toMatchObject({
      tables: [{ name: "alpine" }],
      totalCount: 2,
    });
  });

  test("uses publishable credentials without manufacturing an authorization token", async () => {
    let captured: Request | undefined;
    const client = createClient(
      async (input, init) => {
        captured = new Request(input, init);
        return Response.json([]);
      },
      { kind: "publishable", key: "publishable-key-value" },
    );

    await client.listTables();
    expect(captured?.headers.get("x-mekka-publishable-key")).toBe("publishable-key-value");
    expect(captured?.headers.has("authorization")).toBe(false);
  });

  test("rejects malformed successful provider responses", async () => {
    const client = createClient(async () =>
      Response.json([{ name: "notes", columns: "raw pragma", primaryKey: [], indexes: [] }]),
    );
    await expect(client.listTables()).rejects.toMatchObject({
      code: "infrastructure",
      status: 503,
    });
  });

  test("enforces the response cap in UTF-8 bytes instead of UTF-16 code units", async () => {
    const client = createClient(async () =>
      Response.json([
        {
          name: "notes",
          columns: [],
          primaryKey: [],
          indexes: [],
          padding: "é".repeat(1024 * 1024 + 1),
        },
      ]),
    );

    await expect(client.listTables()).rejects.toMatchObject({ code: "infrastructure" });
  });

  test.each([
    [401, "auth"],
    [403, "forbidden"],
    [409, "conflict"],
    [503, "infrastructure"],
  ] as const)("maps HTTP %d to a typed %s error", async (status, code) => {
    const client = createClient(async () =>
      Response.json(
        { error: { code, message: "provider detail", correlationId } },
        { status, headers: { [tenantHeaders.correlationId]: correlationId } },
      ),
    );

    try {
      await client.listTables();
      throw new Error("Expected listTables to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioDomainError);
      expect(error).toMatchObject({ code, status, correlationId });
      expect((error as Error).message).not.toContain("provider detail");
    }
  });

  test("forwards cancellation without converting it to an infrastructure error", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const client = createClient((_input, init) => {
      receivedSignal = init?.signal;
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const pending = client.listTables({ signal: controller.signal });
    await started;
    controller.abort(new DOMException("Cancelled", "AbortError"));

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toMatchObject({ name: "AbortError", message: "Cancelled" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("bounds reads and reports a retryable timeout without marking an outcome ambiguous", async () => {
    let capturedSignal: AbortSignal | null | undefined;
    const client = createStudioDomainClient({
      baseUrl: "http://studio-backend.local/sqlite-meta",
      tenant,
      requestTimeoutMs: 10,
      fetch: (_input, init) => {
        capturedSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });

    await expect(client.getSchemaHealth()).rejects.toMatchObject({
      code: "infrastructure",
      status: 504,
      outcomeAmbiguous: false,
    });
    expect(capturedSignal?.aborted).toBe(true);
  });

  test("allows only supported table mutations and returns the generated migration diff", async () => {
    let captured: Request | undefined;
    const client = createClient(async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        resource: {
          name: "notes",
          columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKeyPosition: 1 }],
          primaryKey: ["id"],
        },
        migrationSql: 'CREATE TABLE "notes" ("id" INTEGER NOT NULL, PRIMARY KEY ("id"))',
        checkpointId: null,
      });
    });

    const result = await client.createTable(
      {
        name: "notes",
        columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
        expectedSchemaHash: "a".repeat(64),
      },
      "create-notes-idempotency",
    );

    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("idempotency-key")).toBe("create-notes-idempotency");
    expect(await captured?.json()).toEqual({
      name: "notes",
      columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
      expectedSchemaHash: "a".repeat(64),
    });
    expect(result.migrationSql).toStartWith('CREATE TABLE "notes"');
    await expect(
      client.createTable(
        {
          name: "notes;drop",
          columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
          expectedSchemaHash: "a".repeat(64),
        },
        "create-invalid-idempotency",
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      client.createTable(
        {
          name: "sqlite_shadow",
          columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }],
          expectedSchemaHash: "a".repeat(64),
        },
        "create-reserved-idempotency",
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      client.renameTable(
        { table: "notes", name: "_mekka_notes", expectedSchemaHash: "a".repeat(64) },
        "rename-reserved-idempotency",
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  test("bounds structured mutations and marks timed out outcomes as ambiguous", async () => {
    let captured: Request | undefined;
    const client = createStudioDomainClient({
      baseUrl: "http://studio-backend.local/sqlite-meta",
      tenant,
      mutationTimeoutMs: 10,
      fetch: (input, init) => {
        captured = new Request(input, init);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });

    await expect(
      client.createRow("notes", { id: 1 }, "create-row-timeout-001"),
    ).rejects.toMatchObject({
      code: "infrastructure",
      status: 504,
      outcomeAmbiguous: true,
    });
    expect(captured?.signal.aborted).toBe(true);
    expect(captured?.headers.get("idempotency-key")).toBe("create-row-timeout-001");
  });

  test("bounds a mutation even if credential resolution hangs", async () => {
    const client = createStudioDomainClient({
      baseUrl: "http://studio-backend.local/sqlite-meta",
      tenant,
      mutationTimeoutMs: 10,
      getCredential: () => new Promise(() => undefined),
      fetch: async () => {
        throw new Error("fetch must not be reached");
      },
    });

    await expect(
      client.deleteRow("notes", { column: "id", value: "1" }, "delete-row-timeout-001"),
    ).rejects.toMatchObject({ status: 504, outcomeAmbiguous: true });
  });

  test("marks mutation network failures as ambiguous without retrying", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      requests.push(new Request(input, init));
      throw new TypeError("connection reset");
    });

    await expect(
      client.updateRow(
        "notes",
        { column: "id", value: 1 },
        { body: "updated" },
        "update-row-network-001",
      ),
    ).rejects.toMatchObject({ outcomeAmbiguous: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("update-row-network-001");
  });

  test.each([502, 503, 504])(
    "marks mutation HTTP %d gateway outcomes as ambiguous",
    async (status) => {
      const client = createClient(async () =>
        Response.json(
          { error: { code: "infrastructure", correlationId } },
          { status, headers: { [tenantHeaders.correlationId]: correlationId } },
        ),
      );

      await expect(
        client.createRow("notes", { id: 1 }, `create-row-gateway-${status}`),
      ).rejects.toMatchObject({ status, outcomeAmbiguous: true });
    },
  );

  test("uses bounded row and SQL contracts without exposing provider fields", async () => {
    const requests: Request[] = [];
    const client = createClient(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.includes("/rows/notes?")) {
        return Response.json({
          rows: [{ id: 1, body: "first", rawSqliteValue: { blocked: true } }],
          totalCount: 1,
          limit: 50,
          offset: 0,
        });
      }
      return Response.json({ rows: [{ value: 1 }], changes: 0 });
    });

    await expect(client.listRows("notes")).rejects.toMatchObject({ code: "infrastructure" });
    const result = await client.runSql({ sql: "SELECT 1 AS value LIMIT 1" }, "sql-contract-test01");

    expect(result).toEqual({ rows: [{ value: 1 }], changes: 0 });
    expect(requests.at(-1)?.url).toEndWith("/sql");
    await expect(
      client.runSql({ sql: "SELECT 1 LIMIT 1; SELECT 2 LIMIT 1" }, "sql-contract-test02"),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("creates onboarding through a session-only contract without accepting server secrets", async () => {
    let captured: Request | undefined;
    const client = createStudioOnboardingClient({
      baseUrl: "http://studio-backend.local",
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return Response.json({
          id: "onboarding-001",
          projectId: "prj-notes",
          status: "ready",
          phase: "complete",
          errorCode: null,
          connection: {
            apiUrl: "https://api.mekka.test/prj-notes",
            publishableKey: "pk_publishable_value",
            serviceRoleKey: "must-not-leak",
          },
        });
      },
    });

    const result = await client.create(
      {
        organizationName: "Mekka Team",
        projectName: "Notes",
        region: "us-east-1",
        template: "empty",
        enabledModules: ["auth"],
      },
      "onboarding-create-001",
    );

    expect(captured?.headers.get("authorization")).toBe("Bearer session-token-value");
    expect(captured?.headers.get("idempotency-key")).toBe("onboarding-create-001");
    expect(result.connection).toEqual({
      apiUrl: "https://api.mekka.test/prj-notes",
      publishableKey: "pk_publishable_value",
    });
    expect(Object.keys(result.connection ?? {})).not.toContain("serviceRoleKey");
  });

  test("manages previews through the tenant contract without exposing provider secrets", async () => {
    const requests: Request[] = [];
    const client = createStudioPreviewClient({
      baseUrl: "http://studio-backend.local/sqlite-meta",
      tenant,
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "POST" && request.url.endsWith("/previews")) {
          return Response.json({
            name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
            state: "provisioning",
            resourceId: "",
            hostname: null,
            createdAt: 1,
            updatedAt: 1,
            promotedAt: null,
            errorCode: null,
            errorMessage: null,
            schemaHash: "a".repeat(64),
            token: "db-token-must-not-leak",
          });
        }
        if (request.url.endsWith("/status")) {
          return Response.json({
            name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
            state: "failed",
            resourceId: "id-mekka-org-main",
            hostname: "mekka-org-main.example.turso.io",
            createdAt: 1,
            updatedAt: 2,
            promotedAt: null,
            errorCode: "ENGINE_NOT_FOUND",
            errorMessage: "The provider resource no longer exists; delete the preview.",
            schemaHash: "a".repeat(64),
          });
        }
        if (request.method === "DELETE") {
          return Response.json({
            name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
            state: "deleting",
            resourceId: "id-mekka-org-main",
            hostname: "mekka-org-main.example.turso.io",
            createdAt: 1,
            updatedAt: 3,
            promotedAt: null,
            errorCode: null,
            errorMessage: null,
            schemaHash: "a".repeat(64),
          });
        }
        if (request.url.endsWith("/promote")) {
          return Response.json({
            name: "mekka-org-main-project-main-environmen-1a2b3c4d5e6f",
            state: "ready",
            promotedAt: 4,
            schemaHash: "a".repeat(64),
          });
        }
        if (request.url.endsWith("/previews")) {
          return Response.json([
            {
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
              token: "db-token-must-not-leak",
            },
          ]);
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
    });
    const previewName = "mekka-org-main-project-main-environmen-1a2b3c4d5e6f";

    const created = await client.create();
    expect(created.state).toBe("provisioning");
    expect(JSON.stringify(created)).not.toContain("db-token");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer session-token-value");
    expect(requests[0]?.headers.has("idempotency-key")).toBe(false);

    const listed = await client.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("db-token");

    const refreshed = await client.refreshStatus(previewName);
    expect(refreshed.state).toBe("failed");
    expect(refreshed.errorCode).toBe("ENGINE_NOT_FOUND");

    const deleted = await client.delete(previewName);
    expect(deleted.state).toBe("deleting");
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);

    const promoted = await client.promote(previewName, true, "preview-promote-000001");
    expect(promoted.state).toBe("ready");
    expect(promoted.promotedAt).toBe(4);
    const promoteRequest = requests.find((request) => request.url.endsWith("/promote"));
    expect(promoteRequest?.headers.get("idempotency-key")).toBe("preview-promote-000001");
    expect(promoteRequest?.headers.get(tenantHeaders.generation)).toBe("7");
  });

  test("maps preview provider failures to typed errors and rejects malformed previews", async () => {
    const client = createStudioPreviewClient({
      baseUrl: "http://studio-backend.local/sqlite-meta",
      tenant,
      getCredential: () => ({ kind: "session", token: "session-token-value" }),
      fetch: async (_input, init) => {
        const request = new Request(_input, init);
        if (request.url.endsWith("/promote")) {
          const payload = (await request.json()) as { confirmed?: boolean };
          if (payload.confirmed !== true) {
            return Response.json({ error: { code: "validation" } }, { status: 400 });
          }
        }
        if (!request.url.endsWith("previews")) {
          return Response.json({ error: { code: "conflict" } }, { status: 409 });
        }
        return Response.json([
          {
            name: "invalid preview name",
            state: "ready",
            resourceId: "id",
            hostname: null,
            createdAt: 1,
            updatedAt: 1,
            promotedAt: null,
            errorCode: null,
            errorMessage: null,
            schemaHash: "not-a-hash",
          },
        ]);
      },
    });

    await expect(client.get("Invalid_Name")).rejects.toMatchObject({ code: "validation" });
    await expect(
      client.get("mekka-org-main-project-main-envir-1a2b3c4d5e6f"),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      client.promote(
        "mekka-org-main-project-main-envir-1a2b3c4d5e6f",
        false,
        "preview-promote-000002",
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      client.promote(
        "mekka-org-main-project-main-envir-1a2b3c4d5e6f",
        true,
        "preview-promote-000002",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(client.list()).rejects.toMatchObject({ code: "infrastructure" });
  });
});

function createClient(fetcher: typeof fetch, credential?: StudioCredential) {
  return createStudioDomainClient({
    baseUrl: "http://studio-backend.local/sqlite-meta",
    tenant,
    getCredential: () => credential ?? { kind: "session", token: "session-token-value" },
    fetch: fetcher,
  });
}
