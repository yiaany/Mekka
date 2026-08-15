import {
  defaultLibsqlRequestTimeoutMs,
  EngineError,
  openLibsqlEngine,
  testLibsqlConnection,
} from "@mekka/engine-core";
import { openStorageAdapter } from "@mekka/storage-core";

export type SqliteMetaEngineKind = "bun-sqlite" | "libsql-remote";

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
  fetch?: typeof fetch;
}>;

export function readEngineConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): EngineConfiguration {
  const engineKind = readEngineKind(env.MEKKA_DATA_ENGINE);
  const requestTimeoutMs = readRequestTimeoutMs(env.MEKKA_LIBSQL_REQUEST_TIMEOUT_MS);
  return Object.freeze({
    engineKind,
    url: engineKind === "libsql-remote" ? readRequiredUrl(env.MEKKA_LIBSQL_URL) : undefined,
    tokenReference: env.MEKKA_LIBSQL_TOKEN_ENV?.trim(),
    requestTimeoutMs,
    allowLocalhost: env.MEKKA_LOCAL_DEV === "1",
  });
}

export function openEngineController(configuration: EngineConfiguration): EngineController {
  if (configuration.engineKind === "bun-sqlite") {
    return createLocalEngineController();
  }
  const engine = openLibsqlEngine({
    url: configuration.url as string,
    ...(configuration.tokenReference === undefined
      ? {}
      : { tokenReference: configuration.tokenReference }),
    requestTimeoutMs: configuration.requestTimeoutMs,
    allowLocalhost: configuration.allowLocalhost,
    ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
  });
  let lastTestConnection: EngineLastTest | null = null;
  return Object.freeze({
    engineKind: "libsql-remote",
    status: () =>
      Object.freeze({
        engineKind: "libsql-remote",
        url: redactUrl(configuration.url as string),
        requestTimeoutMs: configuration.requestTimeoutMs,
        lastTestConnection,
      }),
    testConnection: async () => {
      const result = await testLibsqlConnection({
        url: configuration.url as string,
        ...(configuration.tokenReference === undefined
          ? {}
          : { tokenReference: configuration.tokenReference }),
        requestTimeoutMs: configuration.requestTimeoutMs,
        allowLocalhost: configuration.allowLocalhost,
        ...(configuration.fetch === undefined ? {} : { fetch: configuration.fetch }),
      });
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
        lastTestConnection,
      });
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
        lastTestConnection,
      });
    },
    close: () => undefined,
  });
}

function readEngineKind(value: string | undefined): SqliteMetaEngineKind {
  if (value === undefined || value === "bun-sqlite") return "bun-sqlite";
  if (value === "libsql-remote") return "libsql-remote";
  throw new Error('MEKKA_DATA_ENGINE must be "bun-sqlite" or "libsql-remote".');
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
    throw new Error("MEKKA_LIBSQL_URL is required when MEKKA_DATA_ENGINE=libsql-remote.");
  }
  return value.trim();
}

function redactUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}
