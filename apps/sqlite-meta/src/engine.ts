import {
  defaultLibsqlRequestTimeoutMs,
  EngineError,
  openLibsqlEngine,
  openReplicaLibsqlEngine,
  type ReplicaLibsqlFallbackPolicy,
  type ReplicaLibsqlStatus,
  testLibsqlConnection,
} from "@mekka/engine-core";
import { openStorageAdapter } from "@mekka/storage-core";

export type SqliteMetaEngineKind = "bun-sqlite" | "libsql-remote" | "libsql-replica";

export type EngineLastTest = Readonly<{
  testedAt: number;
  ok: boolean;
  engineVersion: string | null;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}>;

export type EngineStatus = Readonly<{
  engineKind: SqliteMetaEngineKind;
  url: string | null;
  requestTimeoutMs: number | null;
  replica: {
    state: ReplicaLibsqlStatus["state"];
    lastSyncAtMs: number | null;
    lastWriteAtMs: number | null;
  } | null;
  lastTestConnection: EngineLastTest | null;
}>;

export type EngineController = Readonly<{
  engineKind: SqliteMetaEngineKind;
  status(): EngineStatus;
  testConnection(): Promise<EngineStatus>;
  close(): void;
}>;

export type EngineConfiguration = Readonly<{
  engineKind: SqliteMetaEngineKind;
  url: string | undefined;
  tokenReference: string | undefined;
  requestTimeoutMs: number;
  allowLocalhost: boolean;
  replicaPath: string | undefined;
  replicaFallbackPolicy: ReplicaLibsqlFallbackPolicy;
  replicaSyncIntervalMs: number | null;
  fetch?: typeof fetch;
}>;

export function readEngineConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): EngineConfiguration {
  const engineKind = readEngineKind(env.MEKKA_DATA_ENGINE);
  const requestTimeoutMs = readRequestTimeoutMs(env.MEKKA_LIBSQL_REQUEST_TIMEOUT_MS);
  return Object.freeze({
    engineKind,
    url:
      engineKind === "libsql-remote" || engineKind === "libsql-replica"
        ? readRequiredUrl(env.MEKKA_LIBSQL_URL)
        : undefined,
    tokenReference: env.MEKKA_LIBSQL_TOKEN_ENV?.trim(),
    requestTimeoutMs,
    allowLocalhost: env.MEKKA_LOCAL_DEV === "1",
    replicaPath: engineKind === "libsql-replica" ? readRequiredReplicaPath(env) : undefined,
    replicaFallbackPolicy: readReplicaFallbackPolicy(env.MEKKA_LIBSQL_REPLICA_FALLBACK),
    replicaSyncIntervalMs: readReplicaSyncIntervalMs(env.MEKKA_LIBSQL_REPLICA_SYNC_INTERVAL_MS),
  });
}

export function openEngineController(configuration: EngineConfiguration): EngineController {
  if (configuration.engineKind === "bun-sqlite") {
    return createLocalEngineController();
  }
  const libsqlOptions = {
    url: configuration.url as string,
    ...(configuration.tokenReference === undefined
      ? {}
      : { tokenReference: configuration.tokenReference }),
    requestTimeoutMs: configuration.requestTimeoutMs,
    allowLocalhost: configuration.allowLocalhost,
    ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
  };
  if (configuration.engineKind === "libsql-replica") {
    return createReplicaLibsqlController(configuration, libsqlOptions);
  }
  const engine = openLibsqlEngine(libsqlOptions);
  let lastTestConnection: EngineLastTest | null = null;
  return Object.freeze({
    engineKind: "libsql-remote",
    status: () =>
      Object.freeze({
        engineKind: "libsql-remote",
        url: redactUrl(configuration.url as string),
        requestTimeoutMs: configuration.requestTimeoutMs,
        replica: null,
        lastTestConnection,
      }),
    testConnection: async () => {
      const result = await testLibsqlConnection(libsqlOptions);
      lastTestConnection = Object.freeze({
        testedAt: Date.now(),
        ok: result.ok,
        engineVersion: result.ok ? result.engineVersion : null,
        latencyMs: result.ok ? result.latencyMs : null,
        errorCode: result.ok ? null : result.error.code,
        errorMessage: result.ok ? null : result.error.message,
      });
      return Object.freeze({
        engineKind: "libsql-remote",
        url: redactUrl(configuration.url as string),
        requestTimeoutMs: configuration.requestTimeoutMs,
        replica: null,
        lastTestConnection,
      });
    },
    close: () => {
      void engine.close();
    },
  });
}

function createReplicaLibsqlController(
  configuration: EngineConfiguration,
  libsqlOptions: {
    url: string;
    tokenReference?: string;
    requestTimeoutMs: number;
    allowLocalhost: boolean;
    fetch?: typeof fetch;
  },
): EngineController {
  const engine = openReplicaLibsqlEngine({
    primary: libsqlOptions,
    replicaPath: configuration.replicaPath as string,
    fallbackPolicy: configuration.replicaFallbackPolicy,
    ...(configuration.replicaSyncIntervalMs === null
      ? {}
      : { syncIntervalMs: configuration.replicaSyncIntervalMs }),
  });
  let lastTestConnection: EngineLastTest | null = null;
  const buildStatus = (replica: ReplicaLibsqlStatus | null): EngineStatus =>
    Object.freeze({
      engineKind: "libsql-replica",
      url: redactUrl(configuration.url as string),
      requestTimeoutMs: configuration.requestTimeoutMs,
      replica:
        replica === null
          ? null
          : Object.freeze({
              state: replica.state,
              lastSyncAtMs: replica.lastSyncAtMs,
              lastWriteAtMs: replica.lastWriteAtMs,
            }),
      lastTestConnection,
    });
  return Object.freeze({
    engineKind: "libsql-replica",
    status: () => buildStatus(engine.status()),
    testConnection: async () => {
      const result = await testLibsqlConnection(libsqlOptions);
      lastTestConnection = Object.freeze({
        testedAt: Date.now(),
        ok: result.ok,
        engineVersion: result.ok ? result.engineVersion : null,
        latencyMs: result.ok ? result.latencyMs : null,
        errorCode: result.ok ? null : result.error.code,
        errorMessage: result.ok ? null : result.error.message,
      });
      return buildStatus(engine.status());
    },
    close: () => {
      void engine.close();
    },
  });
}

function createLocalEngineController(): EngineController {
  let lastTestConnection: EngineLastTest | null = null;
  return Object.freeze({
    engineKind: "bun-sqlite",
    status: () =>
      Object.freeze({
        engineKind: "bun-sqlite",
        url: null,
        requestTimeoutMs: null,
        replica: null,
        lastTestConnection,
      }),
    testConnection: async () => {
      try {
        const storage = openStorageAdapter({
          databasePath: ":memory:",
        });
        try {
          const version = storage.execute<{ version: string }>({
            sql: "SELECT sqlite_version() AS version",
            parameters: [],
          }).rows[0]?.version;
          lastTestConnection = Object.freeze({
            testedAt: Date.now(),
            ok: true,
            engineVersion: version ?? null,
            latencyMs: null,
            errorCode: null,
            errorMessage: null,
          });
        } finally {
          storage.close();
        }
      } catch (error) {
        const mapped =
          error instanceof EngineError
            ? error
            : new EngineError("ENGINE_FAILED", "The local engine test failed.", error);
        lastTestConnection = Object.freeze({
          testedAt: Date.now(),
          ok: false,
          engineVersion: null,
          latencyMs: null,
          errorCode: mapped.code,
          errorMessage: mapped.message,
        });
      }
      return Object.freeze({
        engineKind: "bun-sqlite",
        url: null,
        requestTimeoutMs: null,
        replica: null,
        lastTestConnection,
      });
    },
    close: () => undefined,
  });
}

function readEngineKind(value: string | undefined): SqliteMetaEngineKind {
  if (value === undefined || value === "bun-sqlite") return "bun-sqlite";
  if (value === "libsql-remote") return "libsql-remote";
  if (value === "libsql-replica") return "libsql-replica";
  throw new Error('MEKKA_DATA_ENGINE must be "bun-sqlite", "libsql-remote" or "libsql-replica".');
}

function readRequestTimeoutMs(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return defaultLibsqlRequestTimeoutMs;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60_000) {
    throw new Error("MEKKA_LIBSQL_REQUEST_TIMEOUT_MS must be an integer between 1 and 60_000.");
  }
  return parsed;
}

function readRequiredUrl(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "MEKKA_LIBSQL_URL is required when MEKKA_DATA_ENGINE is libsql-remote or libsql-replica.",
    );
  }
  return value.trim();
}

function readRequiredReplicaPath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const value = env.MEKKA_LIBSQL_REPLICA_PATH;
  if (value === undefined || value.trim().length === 0) {
    throw new Error("MEKKA_LIBSQL_REPLICA_PATH is required when MEKKA_DATA_ENGINE=libsql-replica.");
  }
  return value.trim();
}

function readReplicaFallbackPolicy(value: string | undefined): ReplicaLibsqlFallbackPolicy {
  if (value === undefined || value.trim().length === 0) return "safe-error";
  if (value === "primary" || value === "safe-error") return value;
  throw new Error('MEKKA_LIBSQL_REPLICA_FALLBACK must be "primary" or "safe-error".');
}

function readReplicaSyncIntervalMs(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    throw new Error(
      "MEKKA_LIBSQL_REPLICA_SYNC_INTERVAL_MS must be an integer between 1000 and 3600000.",
    );
  }
  return parsed;
}

function redactUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}
