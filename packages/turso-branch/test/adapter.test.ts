import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineError, EngineOutcome } from "@mekka/engine-core";
import {
  buildBranchDatabaseName,
  createTursoBranchAdapter,
  type TursoBranchAdapter,
  type TursoBranchOperationEvent,
  type TursoBranchTransport,
} from "../src/index";

const TURSO_API_TOKEN_REFERENCE = "TURSO_TEST_API_TOKEN";
const TURSO_API_TOKEN = "turso-test-api-token-secret-value";

type RecordedRequest = Readonly<{
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
  signal: AbortSignal;
}>;

type StubTransport = Readonly<{
  fetch: TursoBranchTransport;
  requests: RecordedRequest[];
  setResponse(handler: (request: RecordedRequest) => Response): void;
  setHang(match: (request: RecordedRequest) => boolean): void;
}>;

const databaseRecord = {
  DbId: "a0de8793-52a2-431c-8284-b5b3cca61ff6",
  Name: "mekka-org-1-proj-2-env-3-br-4-g5-hash1234",
  Hostname: "mekka-org-1-proj-2-env-3-br-4-g5-hash1234-default.turso.io",
  group: "default",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createStubTransport(): StubTransport {
  const requests: RecordedRequest[] = [];
  let handler: ((request: RecordedRequest) => Response) | null = null;
  let hang: ((request: RecordedRequest) => boolean) | null = null;

  const fetch: TursoBranchTransport = async (input, init) => {
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body:
        request.method === "GET" || request.method === "DELETE"
          ? null
          : (await request.text().catch(() => "")) || null,
      signal: request.signal,
    };
    if (typeof recorded.body === "string") {
      try {
        recorded.body = JSON.parse(recorded.body);
      } catch {
        recorded.body = null;
      }
    }
    requests.push(recorded);

    if (hang?.(recorded)) {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("Aborted after signal"));
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (handler !== null) return handler(recorded);
    return jsonResponse({ database: databaseRecord });
  };

  return {
    fetch,
    requests,
    setResponse(handlerFn) {
      handler = handlerFn;
    },
    setHang(match) {
      hang = match;
    },
  };
}

function createAdapter(
  transport: StubTransport,
  overrides: Record<string, unknown> = {},
): TursoBranchAdapter {
  return createTursoBranchAdapter({
    organization: "acme",
    group: "default",
    sourceDatabase: "main",
    apiTokenReference: TURSO_API_TOKEN_REFERENCE,
    requestTimeoutMs: 250,
    fetch: transport.fetch,
    operationIdProvider: () => "op-1",
    ...overrides,
  });
}

const createInput = {
  name: "mekka-org-1-proj-2-env-3-br-4-g5-hash1234",
  tokenExpirationSeconds: 7 * 24 * 3600,
};

beforeEach(() => {
  process.env[TURSO_API_TOKEN_REFERENCE] = TURSO_API_TOKEN;
});

afterEach(() => {
  delete process.env[TURSO_API_TOKEN_REFERENCE];
});

describe("createTursoBranchAdapter", () => {
  test("refuses an empty token reference", () => {
    expect(() =>
      createTursoBranchAdapter({
        organization: "acme",
        group: "default",
        sourceDatabase: "main",
        apiTokenReference: "  ",
      }),
    ).toThrow(/must not be empty/);
  });

  test("refuses a missing server-side token", () => {
    delete process.env[TURSO_API_TOKEN_REFERENCE];
    expect(() =>
      createTursoBranchAdapter({
        organization: "acme",
        group: "default",
        sourceDatabase: "main",
        apiTokenReference: TURSO_API_TOKEN_REFERENCE,
      }),
    ).toThrow(/does not resolve to a non-empty value/);
  });

  test("refuses an invalid organization slug", () => {
    expect(() => createAdapter(createStubTransport(), { organization: "INVALID" })).toThrow(
      /slug must be lowercase alphanumeric/,
    );
  });

  test("refuses an invalid group slug", () => {
    expect(() => createAdapter(createStubTransport(), { group: "" })).toThrow(
      /slug must be lowercase/,
    );
  });

  test("refuses an invalid source database name", () => {
    expect(() => createAdapter(createStubTransport(), { sourceDatabase: "UPPER" })).toThrow(
      /must be lowercase alphanumeric/,
    );
  });

  test("refuses http base URLs outside explicit localhost mode", () => {
    expect(() =>
      createAdapter(createStubTransport(), { baseUrl: "http://api.example.test" }),
    ).toThrow(/loopback hosts/);
  });

  test("accepts http base URLs for loopback hosts in explicit localhost mode", () => {
    expect(() =>
      createAdapter(createStubTransport(), {
        baseUrl: "http://127.0.0.1:4444",
        allowLocalhost: true,
      }),
    ).not.toThrow();
  });

  test("refuses base URLs with embedded credentials or query strings", () => {
    expect(() =>
      createAdapter(createStubTransport(), { baseUrl: "https://user:pass@api.example.test" }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      createAdapter(createStubTransport(), { baseUrl: "https://api.example.test?debug=1" }),
    ).toThrow(/must not contain a query string/);
  });

  test("refuses out-of-range request timeouts", () => {
    expect(() => createAdapter(createStubTransport(), { requestTimeoutMs: 0 })).toThrow(
      /between 1 and 60_000/,
    );
    expect(() => createAdapter(createStubTransport(), { requestTimeoutMs: 70_000 })).toThrow(
      /between 1 and 60_000/,
    );
  });

  test("capabilities reports a supported turso adapter", () => {
    const adapter = createAdapter(createStubTransport());
    expect(adapter.capabilities()).toEqual({
      provider: "turso",
      supported: true,
      reason: null,
    });
  });

  test("publicInfo exposes provider identity without the token", () => {
    const adapter = createAdapter(createStubTransport());
    const info = adapter.publicInfo();
    expect(info.organization).toBe("acme");
    expect(info.group).toBe("default");
    expect(info.sourceDatabase).toBe("main");
    expect(info.baseUrl).toBe("https://api.turso.tech");
    expect(JSON.stringify(info)).not.toContain(TURSO_API_TOKEN);
  });
});

describe("probe", () => {
  test("succeeds against the organization endpoint", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    const result = await adapter.probe();
    expect(result.ok).toBe(true);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.method).toBe("GET");
    expect(transport.requests[0]?.url).toBe("https://api.turso.tech/v1/organizations/acme");
    expect(transport.requests[0]?.authorization).toBe(`Bearer ${TURSO_API_TOKEN}`);
  });

  test("reports an auth failure without leaking the token", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ error: "invalid token" }, 401));
    const result = await adapter.probe();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ENGINE_AUTH");
    expect(result.error?.message).not.toContain(TURSO_API_TOKEN);
  });
});

describe("createBranch", () => {
  test("forks the source database and mints a bounded token", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse((request) => {
      if (request.method === "POST" && request.url.endsWith("/databases")) {
        expect(request.body).toEqual({
          name: createInput.name,
          group: "default",
          seed: { type: "database", name: "main" },
        });
        return jsonResponse({ database: databaseRecord });
      }
      if (request.method === "POST" && request.url.includes("/auth/tokens")) {
        expect(request.url).toContain("expiration=7d");
        expect(request.url).toContain("authorization=full-access");
        return jsonResponse({ jwt: "jwt.database.token.value" });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    const created = await adapter.createBranch(createInput);
    expect(created.database.resourceId).toBe(databaseRecord.DbId);
    expect(created.database.name).toBe(createInput.name);
    expect(created.database.hostname).toBe(databaseRecord.Hostname);
    expect(created.token).toBe("jwt.database.token.value");
    expect(created.tokenExpiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]?.url).toContain(
      `/v1/organizations/acme/databases/${createInput.name}/auth/tokens`,
    );
  });

  test("replays success when the provider reports a conflict for the same branch", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse((request) => {
      if (request.method === "POST" && request.url.endsWith("/databases")) {
        return jsonResponse({ error: "database with name [x] already exists" }, 409);
      }
      if (request.method === "GET") {
        return jsonResponse({
          database: { ...databaseRecord, parent: { id: "parent-id", name: "main" } },
        });
      }
      if (request.method === "POST" && request.url.includes("/auth/tokens")) {
        return jsonResponse({ jwt: "jwt.database.token.value" });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    const created = await adapter.createBranch(createInput);
    expect(created.database.resourceId).toBe(databaseRecord.DbId);
    expect(created.database.parentName).toBe("main");
    expect(created.token).toBe("jwt.database.token.value");
    expect(transport.requests.map((request) => request.method)).toEqual(["POST", "GET", "POST"]);
  });

  test("does not replay success when the conflicting database is not this branch", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse((request) => {
      if (request.method === "POST" && request.url.endsWith("/databases")) {
        return jsonResponse({ error: "database with name [x] already exists" }, 409);
      }
      if (request.method === "GET") {
        return jsonResponse({
          database: { ...databaseRecord, parent: { id: "parent-id", name: "some-other-db" } },
        });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    await expect(adapter.createBranch(createInput)).rejects.toMatchObject({
      code: "ENGINE_CONFLICT",
      operationId: "op-1",
    });
    expect(transport.requests).toHaveLength(2);
  });

  test("does not replay success when the conflicting database no longer exists", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse((request) => {
      if (request.method === "POST" && request.url.endsWith("/databases")) {
        return jsonResponse({ error: "database with name [x] already exists" }, 409);
      }
      if (request.method === "GET") {
        return jsonResponse({ error: "could not find database" }, 404);
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });

    await expect(adapter.createBranch(createInput)).rejects.toMatchObject({
      code: "ENGINE_CONFLICT",
    });
  });

  test("maps provider unavailability to an unknown-outcome error", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ error: "boom" }, 500));
    await expect(adapter.createBranch(createInput)).rejects.toMatchObject({
      code: "ENGINE_UNAVAILABLE",
      outcome: "unknown",
    });
  });

  test("maps rate limiting to ENGINE_RATE_LIMITED", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ error: "too many requests" }, 429));
    await expect(adapter.createBranch(createInput)).rejects.toMatchObject({
      code: "ENGINE_RATE_LIMITED",
    });
  });

  test("rejects invalid names and out-of-range token lifetimes before any request", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    await expect(
      adapter.createBranch({ name: "UPPER", tokenExpirationSeconds: 3600 }),
    ).rejects.toThrow(/must be lowercase alphanumeric/);
    await expect(
      adapter.createBranch({ name: "valid-name", tokenExpirationSeconds: 30 }),
    ).rejects.toThrow(/between 3600 and 2592000/);
    await expect(
      adapter.createBranch({ name: "valid-name", tokenExpirationSeconds: 60 * 60 * 24 * 60 }),
    ).rejects.toThrow(/between 3600 and 2592000/);
    expect(transport.requests).toHaveLength(0);
  });

  test("fails without leaking the database token in errors", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse((request) => {
      if (request.url.includes("/auth/tokens")) {
        return jsonResponse({ jwt: "short" }, 200);
      }
      return jsonResponse({ database: databaseRecord });
    });
    const error = await adapter.createBranch(createInput).then(
      () => null,
      (caught: unknown) => caught as EngineError,
    );
    expect(error?.code).toBe("ENGINE_FAILED");
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("short");
    expect(serialized).not.toContain(TURSO_API_TOKEN);
  });
});

describe("getBranchStatus", () => {
  test("returns the parsed database", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() =>
      jsonResponse({
        database: {
          ...databaseRecord,
          parent: { id: "parent-id", name: "main", branched_at: "2026-08-01T00:00:00Z" },
        },
      }),
    );
    const status = await adapter.getBranchStatus(createInput.name);
    expect(status.exists).toBe(true);
    expect(status.database?.resourceId).toBe(databaseRecord.DbId);
    expect(status.database?.group).toBe("default");
    expect(status.database?.parentName).toBe("main");
  });

  test("reports a missing database as not existing", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ error: "could not find database" }, 404));
    const status = await adapter.getBranchStatus(createInput.name);
    expect(status.exists).toBe(false);
    expect(status.database).toBeNull();
  });
});

describe("deleteBranch", () => {
  test("deletes the provider database", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ database: createInput.name }));
    const result = await adapter.deleteBranch(createInput.name);
    expect(result.deleted).toBe(true);
    expect(transport.requests[0]?.method).toBe("DELETE");
    expect(transport.requests[0]?.url).toBe(
      `https://api.turso.tech/v1/organizations/acme/databases/${createInput.name}`,
    );
  });

  test("treats deleting a missing database as success (idempotent retry)", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setResponse(() => jsonResponse({ error: "could not find database" }, 404));
    const result = await adapter.deleteBranch(createInput.name);
    expect(result.deleted).toBe(true);
  });
});

describe("bounded transport", () => {
  test("times out hung requests with an unknown outcome and a bounded latency", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport, { requestTimeoutMs: 20 });
    transport.setHang(() => true);
    const startedAt = Date.now();
    const result = await adapter.probe();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ENGINE_TIMEOUT");
    expect(result.error?.outcome).toBe("unknown");
    expect(result.error?.operationId).toBe("op-1");
  });

  test("propagates the caller's abort signal", async () => {
    const transport = createStubTransport();
    const adapter = createAdapter(transport);
    transport.setHang(() => true);
    const controller = new AbortController();
    const pending = adapter.probe({ operationId: "op-abort", signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ENGINE_TIMEOUT");
    expect(result.error?.outcome).toBe("unknown");
  });
});

describe("operation events", () => {
  test("emits one minimal event per operation without secrets", async () => {
    const events: TursoBranchOperationEvent[] = [];
    const transport = createStubTransport();
    const adapter = createAdapter(transport, { onOperation: (event) => events.push(event) });
    transport.setResponse((request) => {
      if (request.url.includes("/auth/tokens")) {
        return jsonResponse({ jwt: "jwt.database.token.value" });
      }
      return jsonResponse({ database: databaseRecord });
    });

    await adapter.createBranch(createInput);
    expect(events).toHaveLength(2);
    const [createEvent, tokenEvent] = events;
    expect(createEvent?.operation).toBe("create");
    expect(createEvent?.outcome).toBe("ok");
    expect(createEvent?.errorCode).toBeNull();
    expect(tokenEvent?.operation).toBe("token");
    expect(createEvent.operationId).toBe("op-1");
    expect(createEvent.latencyMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(TURSO_API_TOKEN);
    expect(serialized).not.toContain("jwt.database.token.value");
    expect(serialized).not.toContain(databaseRecord.Name);
  });

  test("emits typed error events for failed operations", async () => {
    const events: TursoBranchOperationEvent[] = [];
    const transport = createStubTransport();
    const adapter = createAdapter(transport, { onOperation: (event) => events.push(event) });
    transport.setResponse(() => jsonResponse({ error: "invalid token" }, 401));
    await adapter.probe();
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome as EngineOutcome).toBe("failed");
    expect(events[0]?.errorCode).toBe("ENGINE_AUTH");
  });
});

describe("buildBranchDatabaseName", () => {
  const tenant = {
    organizationId: "org-123",
    projectId: "proj-456",
    environmentId: "env-789",
    branchId: "br-101",
    generation: 2,
  };

  test("is deterministic for the same tenant", () => {
    expect(buildBranchDatabaseName(tenant)).toBe(buildBranchDatabaseName(tenant));
  });

  test("matches the provider name rules and stays within 64 characters", () => {
    const name = buildBranchDatabaseName(tenant);
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("mekka-")).toBe(true);
  });

  test("differs across tenants", () => {
    const other = { ...tenant, branchId: "br-202" };
    expect(buildBranchDatabaseName(tenant)).not.toBe(buildBranchDatabaseName(other));
  });

  test("embeds the generation", () => {
    expect(buildBranchDatabaseName({ ...tenant, generation: 3 })).not.toBe(
      buildBranchDatabaseName(tenant),
    );
  });
});
