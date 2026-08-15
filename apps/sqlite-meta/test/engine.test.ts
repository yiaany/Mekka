import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantContext, ProtocolError, type TenantContext } from "@mekka/protocol";
import { createSqliteMetaApp } from "../src/app";
import { type EngineStatus, openEngineController, readEngineConfiguration } from "../src/engine";
import { isInternalProxyRequest } from "../src/internal-proxy";

const temporaryDirectories: string[] = [];
const internalProxyToken = "engine-test-internal-proxy-token-1234567890";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true, maxRetries: 2 })),
  );
});

function createContext(): TenantContext {
  return createTenantContext({
    tenant: {
      organizationId: "org-test",
      projectId: "project-test",
      environmentId: "env-test",
      branchId: "branch-test",
      generation: 1,
    },
    actor: { kind: "service", id: "studio-local" },
    capabilities: [],
    correlationId: "018e6c28-0000-7000-8000-000000000001",
  });
}

async function createEngineFixture(engine: {
  status(): EngineStatus;
  testConnection(): Promise<EngineStatus>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "mekka-engine-routes-"));
  temporaryDirectories.push(directory);
  const app = createSqliteMetaApp({
    authenticate(request) {
      if (!isInternalProxyRequest(request, internalProxyToken, false)) {
        throw new ProtocolError("auth");
      }
      return createContext();
    },
    resolveProject() {
      throw new Error("unused");
    },
    recordAudit() {},
    checkpointDirectory: directory,
    engine,
    now: () => 1,
  });
  return { app };
}

function proxyHeaders(): HeadersInit {
  return {
    "x-mekka-internal-proxy": internalProxyToken,
    "x-mekka-organization-id": "org-test",
    "x-mekka-project-id": "project-test",
    "x-mekka-environment-id": "env-test",
    "x-mekka-branch-id": "branch-test",
    "x-mekka-generation": "1",
  };
}

describe("engine configuration", () => {
  test("defaults to bun-sqlite without env configuration", () => {
    const configuration = readEngineConfiguration({});
    expect(configuration.engineKind).toBe("bun-sqlite");
    expect(configuration.url).toBeUndefined();
    expect(configuration.requestTimeoutMs).toBeGreaterThan(0);
  });

  test("reads libsql-remote configuration and validates required values", () => {
    const configuration = readEngineConfiguration({
      MEKKA_DATA_ENGINE: "libsql-remote",
      MEKKA_LIBSQL_URL: "https://db.example.turso.io",
      MEKKA_LIBSQL_TOKEN_ENV: "MEKKA_LIBSQL_TOKEN",
      MEKKA_LIBSQL_REQUEST_TIMEOUT_MS: "5000",
    });
    expect(configuration.engineKind).toBe("libsql-remote");
    expect(configuration.url).toBe("https://db.example.turso.io");
    expect(configuration.tokenReference).toBe("MEKKA_LIBSQL_TOKEN");
    expect(configuration.requestTimeoutMs).toBe(5000);
  });

  test("rejects invalid engine configuration", () => {
    expect(() => readEngineConfiguration({ MEKKA_DATA_ENGINE: "postgres" })).toThrow(
      /MEKKA_DATA_ENGINE/,
    );
    expect(() => readEngineConfiguration({ MEKKA_DATA_ENGINE: "libsql-remote" })).toThrow(
      /MEKKA_LIBSQL_URL/,
    );
    expect(() =>
      readEngineConfiguration({
        MEKKA_DATA_ENGINE: "libsql-remote",
        MEKKA_LIBSQL_URL: "https://db.example.turso.io",
        MEKKA_LIBSQL_REQUEST_TIMEOUT_MS: "0",
      }),
    ).toThrow(/MEKKA_LIBSQL_REQUEST_TIMEOUT_MS/);
  });

  test("reads libsql-replica configuration and requires a local replica path", () => {
    const configuration = readEngineConfiguration({
      MEKKA_DATA_ENGINE: "libsql-replica",
      MEKKA_LIBSQL_URL: "https://db.example.turso.io",
      MEKKA_LIBSQL_REPLICA_PATH: "C:\\data\\replica.db",
      MEKKA_LIBSQL_REPLICA_FALLBACK: "primary",
      MEKKA_LIBSQL_REPLICA_SYNC_INTERVAL_MS: "5000",
    });
    expect(configuration.engineKind).toBe("libsql-replica");
    expect(configuration.url).toBe("https://db.example.turso.io");
    expect(configuration.replicaPath).toBe("C:\\data\\replica.db");
    expect(configuration.replicaFallbackPolicy).toBe("primary");
    expect(configuration.replicaSyncIntervalMs).toBe(5000);
  });

  test("defaults replica fallback to safe-error and disables the sync timer", () => {
    const configuration = readEngineConfiguration({
      MEKKA_DATA_ENGINE: "libsql-replica",
      MEKKA_LIBSQL_URL: "https://db.example.turso.io",
      MEKKA_LIBSQL_REPLICA_PATH: "C:\\data\\replica.db",
    });
    expect(configuration.replicaFallbackPolicy).toBe("safe-error");
    expect(configuration.replicaSyncIntervalMs).toBeNull();
  });

  test("rejects incomplete libsql-replica configuration", () => {
    expect(() => readEngineConfiguration({ MEKKA_DATA_ENGINE: "libsql-replica" })).toThrow(
      /MEKKA_LIBSQL_URL/,
    );
    expect(() =>
      readEngineConfiguration({
        MEKKA_DATA_ENGINE: "libsql-replica",
        MEKKA_LIBSQL_URL: "https://db.example.turso.io",
      }),
    ).toThrow(/MEKKA_LIBSQL_REPLICA_PATH/);
    expect(() =>
      readEngineConfiguration({
        MEKKA_DATA_ENGINE: "libsql-replica",
        MEKKA_LIBSQL_URL: "https://db.example.turso.io",
        MEKKA_LIBSQL_REPLICA_PATH: "C:\\data\\replica.db",
        MEKKA_LIBSQL_REPLICA_FALLBACK: "banana",
      }),
    ).toThrow(/MEKKA_LIBSQL_REPLICA_FALLBACK/);
    expect(() =>
      readEngineConfiguration({
        MEKKA_DATA_ENGINE: "libsql-replica",
        MEKKA_LIBSQL_URL: "https://db.example.turso.io",
        MEKKA_LIBSQL_REPLICA_PATH: "C:\\data\\replica.db",
        MEKKA_LIBSQL_REPLICA_SYNC_INTERVAL_MS: "500",
      }),
    ).toThrow(/MEKKA_LIBSQL_REPLICA_SYNC_INTERVAL_MS/);
  });
});

describe("engine controller", () => {
  test("bun-sqlite controller reports the local engine and passes an explicit connection test", async () => {
    const controller = openEngineController(
      readEngineConfiguration({ MEKKA_DATA_ENGINE: "bun-sqlite" }),
    );

    const initial = controller.status();
    expect(initial.engineKind).toBe("bun-sqlite");
    expect(initial.url).toBeNull();
    expect(initial.lastTestConnection).toBeNull();

    const after = await controller.testConnection();
    expect(after.lastTestConnection?.ok).toBe(true);
    expect(after.lastTestConnection?.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("libsql-remote controller redacts the URL and records explicit test results", async () => {
    const previous = process.env.MEKKA_TEST_LIBSQL_TOKEN;
    process.env.MEKKA_TEST_LIBSQL_TOKEN = "server-token-1234567890";
    try {
      const controller = openEngineController({
        engineKind: "libsql-remote",
        url: "https://db.example.turso.io",
        tokenReference: "MEKKA_TEST_LIBSQL_TOKEN",
        requestTimeoutMs: 200,
        allowLocalhost: false,
        fetch: async () => new Response("{}", { status: 401 }),
      });

      const initial = controller.status();
      expect(initial.engineKind).toBe("libsql-remote");
      expect(initial.url).toBe("https://db.example.turso.io");
      expect(JSON.stringify(initial)).not.toContain("server-token-1234567890");

      const after = await controller.testConnection();
      expect(after.lastTestConnection).not.toBeNull();
      expect(after.lastTestConnection?.ok).toBe(false);
      expect(after.lastTestConnection?.errorCode).toBe("ENGINE_AUTH");
      expect(JSON.stringify(after)).not.toContain("server-token-1234567890");
    } finally {
      if (previous === undefined) delete process.env.MEKKA_TEST_LIBSQL_TOKEN;
      else process.env.MEKKA_TEST_LIBSQL_TOKEN = previous;
    }
  });
});

describe("engine status API", () => {
  test("GET /engine/status requires the internal proxy and returns a redacted status", async () => {
    const status: EngineStatus = Object.freeze({
      engineKind: "bun-sqlite",
      url: null,
      requestTimeoutMs: null,
      replica: null,
      lastTestConnection: null,
    });
    const { app } = await createEngineFixture({
      status: () => status,
      testConnection: async () => status,
    });

    const unauthenticated = await app.handle(new Request("http://meta/engine/status"));
    expect(unauthenticated.status).toBe(401);

    const response = await app.handle(
      new Request("http://meta/engine/status", { headers: proxyHeaders() }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(status);
  });

  test("POST /engine/test-connection returns the explicit result and is not cached", async () => {
    const status: EngineStatus = Object.freeze({
      engineKind: "libsql-remote",
      url: "https://db.example.turso.io",
      requestTimeoutMs: 200,
      replica: null,
      lastTestConnection: null,
    });
    const tested: EngineStatus = Object.freeze({
      ...status,
      lastTestConnection: Object.freeze({
        testedAt: 1,
        ok: false,
        engineVersion: null,
        latencyMs: null,
        errorCode: "ENGINE_AUTH",
        errorMessage: "The remote engine rejected the server-side credentials.",
      }),
    });
    const { app } = await createEngineFixture({
      status: () => status,
      testConnection: async () => tested,
    });

    const response = await app.handle(
      new Request("http://meta/engine/test-connection", {
        method: "POST",
        headers: proxyHeaders(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(tested);
  });

  test("engine status API is not configured when no engine dependencies are provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-engine-unconfigured-"));
    temporaryDirectories.push(directory);
    const app = createSqliteMetaApp({
      authenticate: () => createContext(),
      resolveProject() {
        throw new Error("unused");
      },
      recordAudit() {},
      checkpointDirectory: directory,
    });

    const response = await app.handle(
      new Request("http://meta/engine/status", { headers: proxyHeaders() }),
    );
    expect(response.status).toBe(404);
  });
});
