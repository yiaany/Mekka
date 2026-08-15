import { Database } from "bun:sqlite";
import {
  defaultBusyTimeoutMs,
  defaultMinimumEngineVersion,
  mapDatabaseError,
  parseVersion,
  StorageAdapterError,
  validateBusyTimeout,
  validateDatabasePath,
  validateStatement,
  verifyConnectionInvariants,
  verifyEngineVersion,
} from "@mekka/storage-core";
import {
  type Engine,
  type EngineCapabilities,
  EngineError,
  type EngineExecutor,
  type EngineResult,
  type EngineStatement,
  type EngineValue,
} from "./index";

export type SqliteEngineOptions = Readonly<{
  databasePath: string;
  databaseDirectory?: string;
  busyTimeoutMs?: number;
  minimumEngineVersion?: string;
}>;

const sqliteCapabilities: EngineCapabilities = Object.freeze({
  transactions: true,
  dialect: "sqlite",
  remote: false,
});

export function openSqliteEngine(options: SqliteEngineOptions): Engine {
  let database: Database | undefined;
  try {
    const databasePath = validateDatabasePath(options.databasePath, options.databaseDirectory);
    const busyTimeoutMs = validateBusyTimeout(options.busyTimeoutMs ?? defaultBusyTimeoutMs);
    const minimumEngineVersion = parseVersion(
      options.minimumEngineVersion ?? defaultMinimumEngineVersion,
      "minimumEngineVersion",
    );
    database = new Database(databasePath, { strict: true });

    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA synchronous = NORMAL");
    database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    verifyConnectionInvariants(database, busyTimeoutMs);
    verifyEngineVersion(database, minimumEngineVersion);
  } catch (error) {
    database?.close(false);
    throw mapEngineError(error);
  }

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
    return Promise.resolve().then(() => executeStatement<Row>(database, statement));
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
      try {
        database.run("BEGIN IMMEDIATE");
      } catch (error) {
        inTransaction = false;
        throw mapEngineError(error);
      }

      try {
        const result = await callback(Object.freeze({ execute }));
        database.run("COMMIT");
        return result;
      } catch (error) {
        try {
          database.run("ROLLBACK");
        } catch {
          // Preserve the original failure; the database may already be lost.
        }
        throw error instanceof Error ? error : mapEngineError(error);
      } finally {
        inTransaction = false;
      }
    })();
  };

  return Object.freeze({
    engineKind: "sqlite",
    capabilities: sqliteCapabilities,
    execute,
    transaction,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      database.close(false);
      return Promise.resolve();
    },
  });
}

function executeStatement<Row extends Record<string, EngineValue>>(
  database: Database,
  statement: EngineStatement,
): EngineResult<Row> {
  try {
    validateStatement(statement);
    const query = database.query<Row, EngineValue[]>(statement.sql);
    const parameters = [...(statement.parameters ?? [])];
    const rows = query.all(...parameters);
    const changes =
      database.query<{ changes: number }, []>("SELECT changes() AS changes").get()?.changes ?? 0;
    const lastInsertRowid =
      database
        .query<{ lastInsertRowid: number | bigint }, []>(
          "SELECT last_insert_rowid() AS lastInsertRowid",
        )
        .get()?.lastInsertRowid ?? 0n;

    return Object.freeze({ rows: Object.freeze(rows), changes, lastInsertRowid });
  } catch (error) {
    throw mapEngineError(mapDatabaseError(error));
  }
}

function mapEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
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
          "Database remained busy after the configured timeout.",
          error,
        );
      default:
        return new EngineError("ENGINE_FAILED", "Engine configuration is invalid.", error);
    }
  }
  return new EngineError("ENGINE_FAILED", "Engine operation failed unexpectedly.", error);
}
