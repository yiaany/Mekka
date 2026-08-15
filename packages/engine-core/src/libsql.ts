import {
  type Client,
  createClient,
  LibsqlError,
  type ResultSet,
  type Transaction,
} from "@libsql/client";
import { StorageAdapterError, validateStatement } from "@mekka/storage-core";
import {
  type Engine,
  type EngineCapabilities,
  EngineError,
  type EngineExecutor,
  type EngineResult,
  type EngineStatement,
  type EngineValue,
} from "./index";

type TransportFetch = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

export type LibsqlEngineOptions = Readonly<{
  /** Database URL. Production requires https://; http:// is accepted only for loopback hosts when `allowLocalhost` is enabled. */
  url: string;
  /**
   * Name of an environment variable holding the server-side auth token. The token value is read once at
   * open time, never returned in errors, logs or API responses, and never leaves the server.
   */
  tokenReference?: string;
  /** Upper bound for every remote request, in milliseconds. Defaults to `defaultLibsqlRequestTimeoutMs`. */
  requestTimeoutMs?: number;
  /** Minimum sqlite engine version expected on the server; verified by `testLibsqlConnection`. */
  minimumEngineVersion?: string;
  /** Allows http:// URLs for loopback hosts (explicit local development mode). Defaults to `false`. */
  allowLocalhost?: boolean;
  /**
   * Custom transport used for every request. Defaults to the global `fetch`. Tests inject a deterministic
   * transport stub here; production callers should not set this option.
   */
  fetch?: TransportFetch;
}>;

export type LibsqlConnectionTestResult =
  | Readonly<{ ok: true; engineVersion: string; latencyMs: number }>
  | Readonly<{ ok: false; error: EngineError }>;

export const defaultLibsqlRequestTimeoutMs = 10_000;
export const defaultMinimumLibsqlEngineVersion = "3.35.0";

const libsqlCapabilities: EngineCapabilities = Object.freeze({
  transactions: true,
  dialect: "sqlite",
  remote: true,
});

const readOnlyFirstKeywords = new Set(["EXPLAIN", "SELECT"]);

export function openLibsqlEngine(options: LibsqlEngineOptions): Engine {
  const config = validateLibsqlConfig(options);
  const client = createClient({
    url: config.url.href,
    ...(config.token === undefined ? {} : { authToken: config.token }),
    intMode: "bigint",
    concurrency: 1,
    fetch: createBoundedFetch(config.requestTimeoutMs, options.fetch),
  });
  let closed = false;
  let inTransaction = false;

  const execute = <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>> => {
    if (closed) {
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "Engine is closed; no further statements are accepted."),
      );
    }
    return (async () => {
      let error: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await executeStatement(client, statement);
        } catch (caught) {
          error = caught;
          const mapped = mapLibsqlError(caught);
          if (attempt === 0 && isReadOnlyStatement(statement.sql) && isSafeToRetry(mapped)) {
            continue;
          }
          throw mapped;
        }
      }
      throw mapLibsqlError(error);
    })();
  };

  const transaction = <T>(callback: (transaction: EngineExecutor) => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "Engine is closed; no further transactions are accepted."),
      );
    }
    if (inTransaction) {
      return Promise.reject(
        new EngineError("ENGINE_FAILED", "Nested transactions are not supported."),
      );
    }

    return (async () => {
      inTransaction = true;
      const remote = await client.transaction("write").catch((error) => {
        inTransaction = false;
        throw mapLibsqlError(error);
      });
      try {
        const result = await callback(Object.freeze({ execute: withTransaction(remote) }));
        await remote.commit();
        return result;
      } catch (error) {
        await remote.rollback().catch(() => undefined);
        throw error instanceof Error ? error : mapLibsqlError(error);
      } finally {
        remote.close();
        inTransaction = false;
      }
    })();
  };

  return Object.freeze({
    engineKind: "libsql-remote",
    capabilities: libsqlCapabilities,
    execute,
    transaction,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      client.close();
      return Promise.resolve();
    },
  });
}

export async function testLibsqlConnection(
  options: LibsqlEngineOptions,
): Promise<LibsqlConnectionTestResult> {
  try {
    const config = validateLibsqlConfig(options);
    const startedAt = performance.now();
    const client = createClient({
      url: config.url.href,
      ...(config.token === undefined ? {} : { authToken: config.token }),
      intMode: "bigint",
      concurrency: 1,
      fetch: createBoundedFetch(config.requestTimeoutMs, options.fetch),
    });
    try {
      const result = await executeStatement<{ version: string }>(client, {
        sql: "SELECT sqlite_version() AS version",
      });
      const engineVersion = result.rows[0]?.version;
      if (typeof engineVersion !== "string") {
        throw new EngineError(
          "ENGINE_FAILED",
          "The remote engine did not report a recognizable sqlite version.",
        );
      }
      const minimum = options.minimumEngineVersion ?? defaultMinimumLibsqlEngineVersion;
      if (compareSemver(engineVersion, minimum) < 0) {
        throw new EngineError(
          "ENGINE_UNSUPPORTED",
          `The remote engine version ${engineVersion} is below the required minimum ${minimum}.`,
        );
      }
      return Object.freeze({
        ok: true,
        engineVersion,
        latencyMs: Math.round(performance.now() - startedAt),
      });
    } finally {
      client.close();
    }
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: mapLibsqlError(error),
    });
  }
}

function withTransaction(remote: Transaction): EngineExecutor["execute"] {
  return <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>> => {
    try {
      validateStatement(statement);
      return remote
        .execute({ sql: statement.sql, args: [...(statement.parameters ?? [])] })
        .then((result) => normalizeResult<Row>(result));
    } catch (error) {
      throw mapLibsqlError(error);
    }
  };
}

async function executeStatement<Row extends Record<string, EngineValue>>(
  client: Client,
  statement: EngineStatement,
): Promise<EngineResult<Row>> {
  validateStatement(statement);
  const result = await client.execute({
    sql: statement.sql,
    args: [...(statement.parameters ?? [])],
  });
  return normalizeResult<Row>(result);
}

function normalizeResult<Row extends Record<string, EngineValue>>(
  result: ResultSet,
): EngineResult<Row> {
  const rows = result.rows.map((row) => {
    const record: Record<string, EngineValue> = {};
    for (let index = 0; index < result.columns.length; index += 1) {
      const column = result.columns[index];
      if (column !== undefined) {
        record[column] = normalizeValue(row[index]);
      }
    }
    return record;
  });
  const lastInsertRowid =
    result.lastInsertRowid === undefined ? 0n : normalizeBigInt(result.lastInsertRowid);
  return Object.freeze({
    rows: Object.freeze(rows) as readonly Row[],
    changes: result.rowsAffected,
    lastInsertRowid,
  });
}

function normalizeValue(value: unknown): EngineValue {
  if (typeof value === "bigint") return normalizeBigInt(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as EngineValue;
}

function normalizeBigInt(value: bigint): number | bigint {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return value;
}

function createBoundedFetch(
  requestTimeoutMs: number,
  transport: TransportFetch | undefined,
): TransportFetch {
  const underlying = transport ?? fetch;
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const parentSignal = init?.signal;
    const onParentAbort = (): void => controller.abort();
    if (parentSignal !== undefined && parentSignal !== null) {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
    try {
      const response = await underlying(input, { ...init, signal: controller.signal });
      if (controller.signal.aborted) {
        throw new TransportTimeoutError("Request exceeded the configured engine timeout.");
      }
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TransportTimeoutError("Request exceeded the configured engine timeout.", error);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

class TransportTimeoutError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransportTimeoutError";
    this.cause = cause;
  }
}

function validateLibsqlConfig(
  options: LibsqlEngineOptions,
): Readonly<{ url: URL; token: string | undefined; requestTimeoutMs: number }> {
  const requestTimeoutMs = validateRequestTimeout(options.requestTimeoutMs);
  const url = validateLibsqlUrl(options.url, options.allowLocalhost === true);
  const token =
    options.tokenReference === undefined ? undefined : readServerToken(options.tokenReference);
  return Object.freeze({ url, token, requestTimeoutMs });
}

function validateRequestTimeout(value: number | undefined): number {
  const timeout = value ?? defaultLibsqlRequestTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new EngineError(
      "ENGINE_FAILED",
      "requestTimeoutMs must be an integer between 1 and 60_000.",
    );
  }
  return timeout;
}

function validateLibsqlUrl(value: string, allowLocalhost: boolean): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("ENGINE_FAILED", "The database URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineError("ENGINE_FAILED", "The database URL is not a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EngineError(
      "ENGINE_UNSUPPORTED",
      'The database URL scheme must be "https:" (or "http:" for loopback local development).',
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EngineError(
      "ENGINE_FAILED",
      "The database URL must not contain credentials; use a server-side token reference instead.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new EngineError(
      "ENGINE_FAILED",
      "The database URL must not contain a query string or fragment.",
    );
  }
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
    if (!allowLocalhost || !isLoopback) {
      throw new EngineError(
        "ENGINE_FAILED",
        '"http://" is allowed only for loopback hosts in explicit local development mode.',
      );
    }
  }
  return url;
}

function readServerToken(tokenReference: string): string {
  const token = process.env[tokenReference];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new EngineError(
      "ENGINE_FAILED",
      `The server-side token reference "${tokenReference}" does not resolve to a non-empty value.`,
    );
  }
  return token;
}

function isReadOnlyStatement(sql: string): boolean {
  const first = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase();
  return first !== undefined && readOnlyFirstKeywords.has(first);
}

function isSafeToRetry(error: EngineError): boolean {
  return error.code === "ENGINE_TIMEOUT" || error.code === "ENGINE_UNAVAILABLE";
}

function mapLibsqlError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error instanceof TransportTimeoutError) {
    return new EngineError("ENGINE_TIMEOUT", "The remote engine request timed out.", error);
  }
  if (error instanceof StorageAdapterError) {
    switch (error.code) {
      case "STORAGE_QUERY_FORBIDDEN":
        return new EngineError(
          "ENGINE_STATEMENT_FORBIDDEN",
          "Statement is not permitted by this engine.",
          error,
        );
      case "STORAGE_BUSY":
        return new EngineError(
          "ENGINE_BUSY",
          "The remote engine remained busy and the statement was not applied.",
          error,
        );
      default:
        return new EngineError("ENGINE_FAILED", "The remote engine operation failed.", error);
    }
  }
  if (error instanceof LibsqlError) {
    const code = error.code ?? "";
    const serverStatus = findHttpStatus(error);
    if (serverStatus !== undefined) {
      if (serverStatus === 401 || serverStatus === 403) {
        return new EngineError(
          "ENGINE_AUTH",
          "The remote engine rejected the server-side credentials.",
          error,
        );
      }
      if (serverStatus === 408 || serverStatus === 504) {
        return new EngineError("ENGINE_TIMEOUT", "The remote engine request timed out.", error);
      }
      if (serverStatus === 409) {
        return new EngineError(
          "ENGINE_CONFLICT",
          "The remote engine rejected the operation because of a conflicting state.",
          error,
        );
      }
      if (serverStatus >= 500) {
        return new EngineError(
          "ENGINE_UNAVAILABLE",
          "The remote engine is temporarily unavailable.",
          error,
        );
      }
    }
    if (code === "SQLITE_BUSY") {
      return new EngineError(
        "ENGINE_BUSY",
        "The remote engine remained busy and the statement was not applied.",
        error,
      );
    }
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      return new EngineError(
        "ENGINE_CONFLICT",
        "The remote engine rejected the statement because of a constraint conflict.",
        error,
      );
    }
    if (/AUTH/i.test(code) || /unauthorized|forbidden|authentication/i.test(error.message)) {
      return new EngineError(
        "ENGINE_AUTH",
        "The remote engine rejected the server-side credentials.",
        error,
      );
    }
    if (
      /UNSUPPORTED|NOT_SUPPORTED|MISUSE|URL_/i.test(code) ||
      /not supported|unsupported/i.test(error.message)
    ) {
      return new EngineError(
        "ENGINE_UNSUPPORTED",
        "The remote engine does not support the requested operation.",
        error,
      );
    }
    if (code === "SERVER_ERROR" || /unavailable|temporarily/i.test(error.message)) {
      return new EngineError(
        "ENGINE_UNAVAILABLE",
        "The remote engine is temporarily unavailable.",
        error,
      );
    }
    if (code === "CLIENT_CLOSED" || code === "TRANSACTION_CLOSED") {
      return new EngineError(
        "ENGINE_FAILED",
        "The remote engine operation failed because the connection was closed.",
        error,
      );
    }
    return new EngineError("ENGINE_FAILED", "The remote engine operation failed.", error);
  }
  if (error instanceof TypeError) {
    return new EngineError("ENGINE_UNAVAILABLE", "The remote engine could not be reached.", error);
  }
  return new EngineError(
    "ENGINE_FAILED",
    "The remote engine operation failed unexpectedly.",
    error,
  );
}

function findHttpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "status" in current &&
      typeof (current as { status: unknown }).status === "number"
    ) {
      return (current as { status: number }).status;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause: unknown }).cause
        : undefined;
  }
  return undefined;
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): readonly number[] =>
    value.split(".").map((segment) => Number(segment) || 0);
  const l = parse(left);
  const r = parse(right);
  for (let index = 0; index < Math.max(l.length, r.length); index += 1) {
    const difference = (l[index] ?? 0) - (r[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
