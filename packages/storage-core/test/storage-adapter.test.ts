import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorageAdapter, type StorageAdapter, StorageAdapterError } from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createTemporaryAdapter(busyTimeoutMs = 50): Promise<{
  adapter: StorageAdapter;
  databasePath: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-storage-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "test.sqlite");

  return {
    adapter: openStorageAdapter({ databaseDirectory: directory, databasePath, busyTimeoutMs }),
    databasePath,
    directory,
  };
}

describe("SQLite StorageAdapter conformance", () => {
  test("uses bound parameters and enforces connection invariants", async () => {
    const { adapter } = await createTemporaryAdapter();

    try {
      adapter.execute({
        sql: "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
      });
      adapter.execute({
        sql: "INSERT INTO accounts (name) VALUES (?)",
        parameters: ["Ada'; DROP TABLE accounts; --"],
      });
      const result = adapter.execute<{ name: string }>({
        sql: "SELECT name FROM accounts WHERE id = ?",
        parameters: [1],
      });
      const invariants = adapter.execute<{
        foreignKeys: number;
        journalMode: string;
        synchronous: number;
        busyTimeout: number;
      }>({
        sql: "SELECT (SELECT foreign_keys FROM pragma_foreign_keys) AS foreignKeys, (SELECT journal_mode FROM pragma_journal_mode) AS journalMode, (SELECT synchronous FROM pragma_synchronous) AS synchronous, (SELECT timeout FROM pragma_busy_timeout) AS busyTimeout",
      });

      expect(result.rows).toEqual([{ name: "Ada'; DROP TABLE accounts; --" }]);
      expect(invariants.rows).toEqual([
        { foreignKeys: 1, journalMode: "wal", synchronous: 1, busyTimeout: 50 },
      ]);
      expect(() => adapter.execute({ sql: "PRAGMA foreign_keys = OFF" })).toThrow(
        StorageAdapterError,
      );
      expect(() => adapter.execute({ sql: "SELECT 1; SELECT 2" })).toThrow(StorageAdapterError);
      expect(() =>
        adapter.execute({ sql: "SELECT load_extension(?)", parameters: ["unsafe"] }),
      ).toThrow(StorageAdapterError);
    } finally {
      adapter.close();
    }
  });

  test("enforces foreign keys", async () => {
    const { adapter } = await createTemporaryAdapter();

    try {
      adapter.execute({ sql: "CREATE TABLE parents (id INTEGER PRIMARY KEY)" });
      adapter.execute({
        sql: "CREATE TABLE children (parent_id INTEGER NOT NULL REFERENCES parents(id))",
      });

      expect(() =>
        adapter.execute({ sql: "INSERT INTO children (parent_id) VALUES (?)", parameters: [42] }),
      ).toThrow();
    } finally {
      adapter.close();
    }
  });

  test("commits successful transactions and rolls back failed transactions", async () => {
    const { adapter } = await createTemporaryAdapter();

    try {
      adapter.execute({ sql: "CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" });
      adapter.transaction((transaction) => {
        transaction.execute({
          sql: "INSERT INTO events (name) VALUES (?)",
          parameters: ["committed"],
        });
      });

      expect(() =>
        adapter.transaction((transaction) => {
          transaction.execute({
            sql: "INSERT INTO events (name) VALUES (?)",
            parameters: ["rolled back"],
          });
          throw new Error("force rollback");
        }),
      ).toThrow("force rollback");

      expect(
        adapter.execute<{ name: string }>({ sql: "SELECT name FROM events ORDER BY id" }).rows,
      ).toEqual([{ name: "committed" }]);
    } finally {
      adapter.close();
    }
  });

  test("returns an explicit busy error after the configured timeout", async () => {
    const { adapter, databasePath } = await createTemporaryAdapter(25);
    const lockHolder = new Database(databasePath);

    try {
      adapter.execute({ sql: "CREATE TABLE locks (id INTEGER PRIMARY KEY)" });
      lockHolder.run("BEGIN EXCLUSIVE");

      expect(() => adapter.execute({ sql: "INSERT INTO locks DEFAULT VALUES" })).toThrow(
        new StorageAdapterError(
          "STORAGE_BUSY",
          "SQLite database remained busy after the configured timeout.",
        ),
      );
    } finally {
      lockHolder.run("ROLLBACK");
      lockHolder.close(false);
      adapter.close();
    }
  });

  test("rejects paths outside the approved directory and unsupported engine versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-storage-"));
    temporaryDirectories.push(directory);

    expect(() =>
      openStorageAdapter({
        databaseDirectory: directory,
        databasePath: join(directory, "..", "outside.sqlite"),
      }),
    ).toThrow(
      new StorageAdapterError(
        "STORAGE_PATH_INVALID",
        "SQLite database path must remain inside the approved database directory.",
      ),
    );
    expect(() =>
      openStorageAdapter({ databasePath: ":memory:", minimumEngineVersion: "99.0.0" }),
    ).toThrow(/below the required 99\.0\.0/);
  });
});
