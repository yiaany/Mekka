import { createClient, type ResultSet } from "@libsql/client";
import { validateStatement } from "@mekka/storage-core";
import {
  type EngineCapabilities,
  EngineError,
  type EngineExecutor,
  type EngineOutcome,
  type EngineResult,
  type EngineStatement,
  type EngineValue,
} from "./index";
import {
  associateOperationId,
  defaultLibsqlOperationIdProvider,
  mapLibsqlError,
  normalizeResult,
  openLibsqlEngine,
  readServerToken,
  type LibsqlEngineOptions,
  type LibsqlOperationEvent,
  type LibsqlOperationEventObserver,
} from "./libsql";

export type ReplicaLibsqlFallbackPolicy = "primary" | "safe-error";

export type ReplicaLibsqlState = "ready" | "stale" | "unavailable";

export type ReplicaLibsqlStatus = Readonly<{
  state: ReplicaLibsqlState;
  lastSyncAtMs: number | null;
  lastWriteAtMs: number | null;
}>;

export type ReplicaSyncResult = Readonly<{
  ok: boolean;
  state: ReplicaLibsqlState;
  syncedAtMs: number | null;
  error: EngineError | null;
}>;

/**
 * Deterministic test seam for the local replica. Production wires the official embedded
 * replica client (`file:` URL + primary `syncUrl`) here; tests inject a deterministic driver.
 */
export type ReplicaLibsqlReplicaDriver = Readonly<{
  execute<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>>;
  sync(): Promise<void>;
  close(): void;
}>;

export type ReplicaDriverConfig = Readonly<{
  /** Local SQLite file for the embedded replica, as a `file:` URL. */
  replicaUrl: string;
  /** Primary server the replica synchronizes from. */
  syncUrl: string;
  token: string | undefined;
}>;

export type ReplicaLibsqlEngineOptions = Readonly<{
  /** Authoritative engine; writes, transactions, DDL, migrations and raw SQL route here. */
  primary: LibsqlEngineOptions;
  /** Local filesystem path for the embedded replica file. */
  replicaPath: string;
  /** Synchronize at open. Defaults to `true`. */
  syncOnOpen?: boolean;
  /**
   * Single bounded, disableable sync timer in milliseconds. Disabled when `undefined`, `0`
   * or `null`. The timer is always cleared when the adapter closes.
   */
  syncIntervalMs?: number;
  /**
   * Explicit primary fallback policy when the replica is unavailable: `"primary"` routes
   * reads to the primary, `"safe-error"` returns an honest `ENGINE_UNAVAILABLE`.
   */
  fallbackPolicy: ReplicaLibsqlFallbackPolicy;
  /** Deterministic clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Custom local replica driver. Defaults to the official embedded replica client. Tests
   * inject a deterministic driver here; production callers should not set this option.
   */
  createReplicaDriver?: (config: ReplicaDriverConfig) => ReplicaLibsqlReplicaDriver;
  /**
   * Delay between the two bounded sync attempts, in milliseconds. The sync retries once with
   * this delay only when the upstream failure is transport-level (outcome `unknown`). Bounded
   * to `[0, 5000]`; defaults to 200.
   */
  syncRetryDelayMs?: number;
  /**
   * Minimal observability sink for replica-local operations (replica reads and syncs). Events
   * never contain SQL text, parameter values, URLs or tokens.
   */
  onOperation?: LibsqlOperationEventObserver;
}>;

export type ReplicaLibsqlEngine = Readonly<{
  readonly engineKind: "libsql-replica";
  readonly capabilities: EngineCapabilities;
  /**
   * Raw SQL always routes to the primary. SQL is never inspected; the profile never
   * classifies statements to decide routing.
   */
  execute<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>>;
  /**
   * Typed read. Reads the local replica by default (eventual reads). Pass
   * `readYourWrites: true` for the current request/session after an upstream write to
   * guarantee read-your-writes from the primary.
   */
  executeTypedRead<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
    options?: Readonly<{ readYourWrites?: boolean }>,
  ): Promise<EngineResult<Row>>;
  /**
   * Typed write; always routes to the primary and marks the replica stale so the current
   * session no longer reads from it (read-your-writes).
   */
  executeTypedWrite<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>>;
  transaction<T>(callback: (transaction: EngineExecutor) => Promise<T>): Promise<T>;
  syncNow(): Promise<ReplicaSyncResult>;
  status(): ReplicaLibsqlStatus;
  close(): Promise<void>;
}>;

const replicaLibsqlCapabilities: EngineCapabilities = Object.freeze({
  transactions: true,
  dialect: "sqlite",
  remote: true,
});

const minimumSyncIntervalMs = 1_000;
const maximumSyncIntervalMs = 3_600_000;
/** Bounded sync retry: at most one retry on top of the initial attempt. */
const maximumSyncAttempts = 2;
const defaultSyncRetryDelayMs = 200;
const maximumSyncRetryDelayMs = 5_000;

export function openReplicaLibsqlEngine(options: ReplicaLibsqlEngineOptions): ReplicaLibsqlEngine {
  const replicaUrl = validateReplicaPath(options.replicaPath);
  const primary = openLibsqlEngine(options.primary);
  const syncIntervalMs = validateSyncIntervalMs(options.syncIntervalMs);
  const syncRetryDelayMs = validateSyncRetryDelayMs(options.syncRetryDelayMs);
  const now = options.now ?? (() => Date.now());
  const operationIdProvider = options.primary.operationIdProvider ?? defaultLibsqlOperationIdProvider;
  const token =
    options.primary.tokenReference === undefined
      ? undefined
      : readServerToken(options.primary.tokenReference);
  const createDriver =
    options.createReplicaDriver ?? createOfficialReplicaDriver;
  let driver: ReplicaLibsqlReplicaDriver | null;
  let driverCreationError: EngineError | null = null;
  try {
    driver = createDriver(
      Object.freeze({
        replicaUrl,
        syncUrl: options.primary.url,
        token,
      }),
    );
  } catch (error) {
    // The embedded replica client connects to the primary at open. An unreachable primary
    // must not take the whole service down: the replica stays reported as unavailable while
    // the primary engine remains usable for writes and reads (per the explicit fallback policy).
    driver = null;
    driverCreationError = mapLibsqlError(error);
  }

  const emitOperation = (event: LibsqlOperationEvent): void => {
    if (options.onOperation === undefined) return;
    try {
      options.onOperation(Object.freeze(event));
    } catch {
      // Observability must never break the data path.
    }
  };

  let closed = false;
  let syncing: Promise<ReplicaSyncResult> | null = null;
  let state: ReplicaLibsqlState = "unavailable";
  let lastSyncAtMs: number | null = null;
  let lastWriteAtMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const markWritten = (): void => {
    lastWriteAtMs = now();
    if (state === "ready") state = "stale";
  };

  const isStale = (): boolean =>
    lastWriteAtMs !== null && (lastSyncAtMs === null || lastWriteAtMs > lastSyncAtMs);

  const syncNow = (): Promise<ReplicaSyncResult> => {
    if (closed) {
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "Replica engine is closed; no sync is accepted."),
      );
    }
    if (syncing !== null) return syncing;
    syncing = (async () => {
      const operationId = operationIdProvider();
      if (driver === null || driverCreationError !== null) {
        state = "unavailable";
        const error = driverCreationError ?? new EngineError(
          "ENGINE_UNAVAILABLE",
          "The local replica could not be created; no sync is possible.",
        );
        const classified = associateOperationId(error, operationId);
        emitOperation({
          operationId,
          route: "replica-sync",
          outcome: classified.outcome,
          errorCode: classified.code,
          latencyMs: 0,
          attempts: 1,
        });
        return Object.freeze({ ok: false, state, syncedAtMs: null, error: classified });
      }
      try {
        for (let attempt = 1; attempt <= maximumSyncAttempts; attempt += 1) {
          const startedAt = performance.now();
          const syncedAt = now();
          try {
            await driver.sync();
            lastSyncAtMs = syncedAt;
            state = isStale() ? "stale" : "ready";
            emitOperation({
              operationId,
              route: "replica-sync",
              outcome: "ok",
              errorCode: null,
              latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
              attempts: attempt,
            });
            return Object.freeze({ ok: true, state, syncedAtMs: syncedAt, error: null });
          } catch (error) {
            const mapped = mapLibsqlError(error);
            state = "unavailable";
            const retryable =
              attempt < maximumSyncAttempts && mapped.outcome === "unknown" && !closed;
            if (retryable) {
              await sleep(syncRetryDelayMs);
              continue;
            }
            const classified = associateOperationId(mapped, operationId);
            emitOperation({
              operationId,
              route: "replica-sync",
              outcome: classified.outcome,
              errorCode: classified.code,
              latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
              attempts: attempt,
            });
            return Object.freeze({ ok: false, state, syncedAtMs: null, error: classified });
          }
        }
        const error = new EngineError(
          "ENGINE_UNAVAILABLE",
          "Replica sync exceeded its bounded retry attempts.",
        );
        const classified = associateOperationId(error, operationId);
        emitOperation({
          operationId,
          route: "replica-sync",
          outcome: "unknown",
          errorCode: classified.code,
          latencyMs: 0,
          attempts: maximumSyncAttempts,
        });
        return Object.freeze({ ok: false, state, syncedAtMs: null, error: classified });
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  };

  const scheduleSync = (): void => {
    if (syncIntervalMs === null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) void syncNow();
      if (!closed) scheduleSync();
    }, syncIntervalMs);
  };

  if (syncIntervalMs !== null) scheduleSync();
  if (options.syncOnOpen !== false) void syncNow();

  const executePrimary = <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>> => {
    if (closed) {
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "Replica engine is closed; no statements are accepted."),
      );
    }
    return primary.execute<Row>(statement);
  };

  const writeToPrimary = <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>> => {
    return executePrimary<Row>(statement).then((result) => {
      markWritten();
      return result;
    });
  };

  const readFromReplica = <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
  ): Promise<EngineResult<Row>> => {
    if (closed) {
      return Promise.reject(
        new EngineError("ENGINE_CLOSED", "Replica engine is closed; no statements are accepted."),
      );
    }
    const operationId = operationIdProvider();
    try {
      validateStatement(statement);
    } catch (error) {
      const mapped = associateOperationId(mapLibsqlError(error), operationId);
      emitOperation({
        operationId,
        route: "replica-read",
        outcome: "failed",
        errorCode: mapped.code,
        latencyMs: 0,
        attempts: 1,
      });
      return Promise.reject(mapped);
    }
    if (state === "unavailable" || isStale()) {
      if (options.fallbackPolicy === "primary" && state === "unavailable") {
        return primary.execute<Row>(statement);
      }
      if (isStale()) {
        // read-your-writes: the current session wrote since the last sync, so it reads the primary.
        return primary.execute<Row>(statement);
      }
      return Promise.reject(
        associateOperationId(
          new EngineError(
            "ENGINE_UNAVAILABLE",
            "The local replica is unavailable and the configured fallback policy is safe-error. " +
              "Run a manual sync before retrying the read.",
          ),
          operationId,
        ),
      );
    }
    if (driver === null) {
      return Promise.reject(
        associateOperationId(
          new EngineError(
            "ENGINE_UNAVAILABLE",
            "The local replica could not be created and the configured fallback policy is safe-error. " +
              "Reconfigure the replica before retrying the read.",
          ),
          operationId,
        ),
      );
    }
    const startedAt = performance.now();
    return driver.execute<Row>(statement)
      .then((result) => {
        emitOperation({
          operationId,
          route: "replica-read",
          outcome: "ok",
          errorCode: null,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: 1,
        });
        return result;
      })
      .catch((error: unknown) => {
        const mapped = associateOperationId(mapLibsqlError(error), operationId);
        emitOperation({
          operationId,
          route: "replica-read",
          outcome: mapped.outcome,
          errorCode: mapped.code,
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          attempts: 1,
        });
        state = "unavailable";
        if (options.fallbackPolicy === "primary") return primary.execute<Row>(statement);
        throw mapped;
      });
  };

  const executeTypedRead = <Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
    readOptions?: Readonly<{ readYourWrites?: boolean }>,
  ): Promise<EngineResult<Row>> => {
    if (readOptions?.readYourWrites === true) return executePrimary<Row>(statement);
    return readFromReplica<Row>(statement);
  };

  return Object.freeze({
    engineKind: "libsql-replica",
    capabilities: replicaLibsqlCapabilities,
    execute: writeToPrimary,
    executeTypedRead,
    executeTypedWrite: writeToPrimary,
    transaction: <T>(callback: (transaction: EngineExecutor) => Promise<T>): Promise<T> =>
      primary
        .transaction(callback)
        .then((result) => {
          markWritten();
          return result;
        }),
    syncNow,
    status: (): ReplicaLibsqlStatus => Object.freeze({ state, lastSyncAtMs, lastWriteAtMs }),
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (driver !== null) driver.close();
      return primary.close();
    },
  });
}

export type ReplicaLibsqlOperation =
  | Readonly<{ kind: "typed-read"; statement: EngineStatement; readYourWrites?: boolean }>
  | Readonly<{ kind: "typed-write"; statement: EngineStatement }>
  | Readonly<{ kind: "ddl"; statement: EngineStatement }>
  | Readonly<{ kind: "migration"; statement: EngineStatement }>
  | Readonly<{ kind: "raw"; statement: EngineStatement }>;

/**
 * Routes an operation purely by its explicit kind — never by SQL inspection. Typed reads may
 * hit the local replica (and read-your-writes inside the same request after a write); typed
 * writes, DDL, migrations and raw SQL always hit the primary.
 */
export async function routeReplicaLibsqlOperation(
  engine: ReplicaLibsqlEngine,
  operation: ReplicaLibsqlOperation,
): Promise<EngineResult> {
  if (operation.kind === "typed-read") {
    return engine.executeTypedRead(operation.statement, {
      ...(operation.readYourWrites === undefined ? {} : { readYourWrites: operation.readYourWrites }),
    });
  }
  return engine.execute(operation.statement);
}

function createOfficialReplicaDriver(config: ReplicaDriverConfig): ReplicaLibsqlReplicaDriver {
  const client = createClient({
    url: config.replicaUrl,
    syncUrl: config.syncUrl,
    ...(config.token === undefined ? {} : { authToken: config.token }),
    intMode: "bigint",
    concurrency: 1,
  });
  return {
    execute: (statement) =>
      client
        .execute({ sql: statement.sql, args: [...(statement.parameters ?? [])] })
        .then((result: ResultSet) => normalizeResult(result)),
    sync: () => client.sync().then(() => undefined),
    close: () => client.close(),
  };
}

function validateReplicaPath(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError(
      "ENGINE_FAILED",
      "The local replica path must not be empty when the replica profile is enabled.",
    );
  }
  const path = value.trim();
  if (path.startsWith("file:")) return path;
  return `file:${path}`;
}

function validateSyncIntervalMs(value: number | undefined): number | null {
  if (value === undefined || value <= 0) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < minimumSyncIntervalMs ||
    value > maximumSyncIntervalMs
  ) {
    throw new EngineError(
      "ENGINE_FAILED",
      `syncIntervalMs must be an integer between ${minimumSyncIntervalMs} and ${maximumSyncIntervalMs}.`,
    );
  }
  return value;
}

function validateSyncRetryDelayMs(value: number | undefined): number {
  if (value === undefined) return defaultSyncRetryDelayMs;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumSyncRetryDelayMs) {
    throw new EngineError(
      "ENGINE_FAILED",
      `syncRetryDelayMs must be an integer between 0 and ${maximumSyncRetryDelayMs}.`,
    );
  }
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}