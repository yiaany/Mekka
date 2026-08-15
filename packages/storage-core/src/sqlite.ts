import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

export type StorageValue = string | number | bigint | Uint8Array | null;

export type StorageStatement = Readonly<{
  sql: string;
  parameters?: readonly StorageValue[];
}>;

export type StorageResult<Row extends Record<string, StorageValue> = Record<string, StorageValue>> =
  Readonly<{
    rows: readonly Row[];
    changes: number;
    lastInsertRowid: number | bigint;
  }>;

export interface StorageExecutor {
  execute<Row extends Record<string, StorageValue> = Record<string, StorageValue>>(
    statement: StorageStatement,
  ): StorageResult<Row>;
}

export interface StorageAdapter extends StorageExecutor {
  transaction<T>(callback: (transaction: StorageExecutor) => T): T;
  createCheckpoint(options: StorageCheckpointOptions): void;
  close(): void;
}

export type StorageCheckpointOptions = Readonly<{
  destinationPath: string;
  destinationDirectory: string;
}>;

export type StorageAdapterOptions = Readonly<{
  databasePath: string;
  databaseDirectory?: string;
  busyTimeoutMs?: number;
  minimumEngineVersion?: string;
}>;

export type StorageErrorCode =
  | "STORAGE_PATH_INVALID"
  | "STORAGE_QUERY_FORBIDDEN"
  | "STORAGE_ENGINE_VERSION_UNSUPPORTED"
  | "STORAGE_BUSY";

export class StorageAdapterError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageAdapterError";
    this.code = code;
  }
}

export const defaultBusyTimeoutMs = 1_000;
export const defaultMinimumEngineVersion = "3.35.0";
const forbiddenStatementKeywords = new Set([
  "attach",
  "begin",
  "commit",
  "detach",
  "end",
  "pragma",
  "release",
  "rollback",
  "savepoint",
  "vacuum",
]);
const forbiddenSqlPattern = /\b(?:load_extension|create\s+virtual\s+table)\b/i;

export function openStorageAdapter(options: StorageAdapterOptions): StorageAdapter {
  const databasePath = validateDatabasePath(options.databasePath, options.databaseDirectory);
  const busyTimeoutMs = validateBusyTimeout(options.busyTimeoutMs ?? defaultBusyTimeoutMs);
  const minimumEngineVersion = parseVersion(
    options.minimumEngineVersion ?? defaultMinimumEngineVersion,
    "minimumEngineVersion",
  );
  const database = new Database(databasePath, { strict: true });

  try {
    configureConnection(database, busyTimeoutMs);
    verifyConnectionInvariants(database, busyTimeoutMs);
    verifyEngineVersion(database, minimumEngineVersion);
  } catch (error) {
    database.close(false);
    throw error;
  }

  const execute = <Row extends Record<string, StorageValue> = Record<string, StorageValue>>(
    statement: StorageStatement,
  ): StorageResult<Row> => executeStatement<Row>(database, statement);

  return Object.freeze({
    execute,
    transaction<T>(callback: (transaction: StorageExecutor) => T): T {
      const runTransaction = database.transaction(() => callback(Object.freeze({ execute })));

      try {
        return runTransaction();
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
    createCheckpoint(options: StorageCheckpointOptions): void {
      const destinationPath = validateDatabasePath(
        options.destinationPath,
        options.destinationDirectory,
      );
      if (existsSync(destinationPath)) {
        throw new StorageAdapterError(
          "STORAGE_PATH_INVALID",
          "Checkpoint destination must not already exist.",
        );
      }

      try {
        // VACUUM INTO creates a consistent SQLite snapshot without copying a live database file.
        database.query<never, [string]>("VACUUM INTO ?").run(destinationPath);
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
    close(): void {
      database.close(false);
    },
  });
}

function configureConnection(database: Database, busyTimeoutMs: number): void {
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = NORMAL");
  database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
}

export function verifyConnectionInvariants(database: Database, busyTimeoutMs: number): void {
  const foreignKeys = database.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
  const journalMode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  const synchronous = database.query<{ synchronous: number }, []>("PRAGMA synchronous").get();
  const configuredBusyTimeout = database
    .query<{ timeout: number }, []>("PRAGMA busy_timeout")
    .get();

  if (
    foreignKeys?.foreign_keys !== 1 ||
    (journalMode?.journal_mode.toLowerCase() !== "wal" &&
      journalMode?.journal_mode.toLowerCase() !== "memory") ||
    synchronous?.synchronous !== 1 ||
    configuredBusyTimeout?.timeout !== busyTimeoutMs
  ) {
    throw new StorageAdapterError(
      "STORAGE_QUERY_FORBIDDEN",
      "SQLite connection invariants could not be established.",
    );
  }
}

export function verifyEngineVersion(
  database: Database,
  minimumEngineVersion: readonly number[],
): void {
  const row = database.query<{ version: string }, []>("SELECT sqlite_version() AS version").get();

  if (
    row === null ||
    row === undefined ||
    compareVersions(parseVersion(row.version, "SQLite version"), minimumEngineVersion) < 0
  ) {
    throw new StorageAdapterError(
      "STORAGE_ENGINE_VERSION_UNSUPPORTED",
      `SQLite engine version ${row?.version ?? "unknown"} is below the required ${minimumEngineVersion.join(".")}.`,
    );
  }
}

function executeStatement<Row extends Record<string, StorageValue>>(
  database: Database,
  statement: StorageStatement,
): StorageResult<Row> {
  validateStatement(statement);

  try {
    const query = database.query<Row, StorageValue[]>(statement.sql);
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
    throw mapDatabaseError(error);
  }
}

export function validateDatabasePath(
  databasePath: string,
  databaseDirectory: string | undefined,
): string {
  if (databasePath === ":memory:") {
    return databasePath;
  }

  if (databaseDirectory === undefined || databasePath.length === 0) {
    throw new StorageAdapterError(
      "STORAGE_PATH_INVALID",
      "A file-backed SQLite database requires an approved database directory.",
    );
  }

  const resolvedDirectory = resolve(databaseDirectory);
  const resolvedPath = resolve(resolvedDirectory, databasePath);
  const pathFromDirectory = relative(resolvedDirectory, resolvedPath);

  if (
    pathFromDirectory.length === 0 ||
    pathFromDirectory === ".." ||
    pathFromDirectory.startsWith(`..\\`) ||
    pathFromDirectory.startsWith("../")
  ) {
    throw new StorageAdapterError(
      "STORAGE_PATH_INVALID",
      "SQLite database path must remain inside the approved database directory.",
    );
  }

  return resolvedPath;
}

export function validateBusyTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new StorageAdapterError(
      "STORAGE_PATH_INVALID",
      "SQLite busy timeout must be a safe integer between 1 and 60000 milliseconds.",
    );
  }

  return value;
}

export function validateStatement(statement: StorageStatement): void {
  if (typeof statement.sql !== "string" || statement.sql.trim().length === 0) {
    throw new StorageAdapterError("STORAGE_QUERY_FORBIDDEN", "SQLite statement must not be empty.");
  }

  if (
    containsMultipleStatements(statement.sql) ||
    forbiddenStatementKeywords.has(firstKeyword(statement.sql)) ||
    forbiddenSqlPattern.test(statement.sql)
  ) {
    throw new StorageAdapterError(
      "STORAGE_QUERY_FORBIDDEN",
      "SQLite statement is not permitted through the storage adapter.",
    );
  }
}

function containsMultipleStatements(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let semicolonFound = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    const nextCharacter = sql.charAt(index + 1);

    if (quote !== null) {
      if (character === quote) {
        if (nextCharacter === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === ";") {
      semicolonFound = true;
    } else if (semicolonFound && !/\s/.test(character)) {
      return true;
    }
  }

  return false;
}

function firstKeyword(sql: string): string {
  const match = sql.match(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*([A-Za-z_]+)/);
  return match?.[1]?.toLowerCase() ?? "";
}

export function parseVersion(value: string, name: string): readonly number[] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);

  if (match === null) {
    throw new StorageAdapterError(
      "STORAGE_ENGINE_VERSION_UNSUPPORTED",
      `${name} must use major.minor.patch format.`,
    );
  }

  return match.slice(1).map((segment) => Number(segment));
}

export function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

export function mapDatabaseError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_BUSY"
  ) {
    return new StorageAdapterError(
      "STORAGE_BUSY",
      "SQLite database remained busy after the configured timeout.",
    );
  }

  return error instanceof Error ? error : new Error("SQLite operation failed.");
}
