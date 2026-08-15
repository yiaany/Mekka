import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Engine, EngineError, openSqliteEngine, requireCapability } from "../src/index";

const temporaryDirectories: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close().catch(() => undefined)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createTemporaryEngine(): Promise<{ engine: Engine; databasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-engine-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "test.sqlite");
  const engine = openSqliteEngine({ databaseDirectory: directory, databasePath });
  engines.push(engine);
  return { engine, databasePath };
}

describe("Engine contract", () => {
  test("exposes engineKind and capabilities for the sqlite engine", async () => {
    const { engine } = await createTemporaryEngine();

    expect(engine.engineKind).toBe("sqlite");
    expect(engine.capabilities).toEqual({
      transactions: true,
      dialect: "sqlite",
      remote: false,
    });
    expect(Object.isFrozen(engine.capabilities)).toBe(true);
  });

  test("requireCapability passes for supported capabilities and fails closed otherwise", async () => {
    const { engine } = await createTemporaryEngine();

    expect(() => requireCapability(engine, "transactions")).not.toThrow();

    let caught: unknown;
    try {
      requireCapability(engine, "remote");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("ENGINE_CAPABILITY_UNSUPPORTED");
  });

  test("EngineError carries a code, a safe message and the original cause", () => {
    const cause = new Error("underlying");
    const error = new EngineError("ENGINE_FAILED", "Engine failed.", cause);

    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toBe("Engine failed.");
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("SQLite engine adapter", () => {
  test("executes parameterized statements and reports rows, changes and lastInsertRowid", async () => {
    const { engine } = await createTemporaryEngine();

    await engine.execute({
      sql: "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    });
    const insert = await engine.execute({
      sql: "INSERT INTO accounts (name) VALUES (?)",
      parameters: ["Ada'; DROP TABLE accounts; --"],
    });
    const result = await engine.execute<{ id: number; name: string }>({
      sql: "SELECT id, name FROM accounts WHERE name = ?",
      parameters: ["Ada'; DROP TABLE accounts; --"],
    });

    expect(insert.changes).toBe(1);
    expect(insert.lastInsertRowid).toBe(1);
    expect(result.rows).toEqual([{ id: 1, name: "Ada'; DROP TABLE accounts; --" }]);
    await engine.close();
  });

  test("rejects forbidden statements with a typed engine error", async () => {
    const { engine } = await createTemporaryEngine();

    for (const statement of [
      { sql: "PRAGMA foreign_keys = OFF" },
      { sql: "SELECT 1; SELECT 2" },
      { sql: "SELECT load_extension(?)", parameters: ["unsafe"] },
    ]) {
      await expect(engine.execute(statement)).rejects.toMatchObject({
        name: "EngineError",
        code: "ENGINE_STATEMENT_FORBIDDEN",
      });
    }
    await engine.close();
  });

  test("commits a transaction when the callback succeeds and rolls back on failure", async () => {
    const { engine } = await createTemporaryEngine();
    await engine.execute({ sql: "CREATE TABLE ledger (id INTEGER PRIMARY KEY, amount INTEGER)" });

    await engine.transaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO ledger (amount) VALUES (?)", parameters: [10] });
      await tx.execute({ sql: "INSERT INTO ledger (amount) VALUES (?)", parameters: [20] });
    });

    const committed = await engine.execute<{ total: number }>({
      sql: "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger",
    });
    expect(committed.rows).toEqual([{ total: 30 }]);

    await expect(
      engine.transaction(async (tx) => {
        await tx.execute({ sql: "INSERT INTO ledger (amount) VALUES (?)", parameters: [999] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const afterRollback = await engine.execute<{ total: number }>({
      sql: "SELECT COALESCE(SUM(amount), 0) AS total FROM ledger",
    });
    expect(afterRollback.rows).toEqual([{ total: 30 }]);
    await engine.close();
  });

  test("rejects nested transactions and leaves the outer transaction intact", async () => {
    const { engine } = await createTemporaryEngine();
    await engine.execute({ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" });

    await expect(
      engine.transaction(async (tx) => {
        await tx.execute({ sql: "INSERT INTO t DEFAULT VALUES" });
        await engine.transaction(async (inner) => {
          await inner.execute({ sql: "INSERT INTO t DEFAULT VALUES" });
        });
      }),
    ).rejects.toMatchObject({ name: "EngineError", code: "ENGINE_FAILED" });

    const rows = await engine.execute<{ count: number }>({
      sql: "SELECT COUNT(*) AS count FROM t",
    });
    expect(rows.rows).toEqual([{ count: 0 }]);
    await engine.close();
  });

  test("close twice is safe and execute after close fails closed", async () => {
    const { engine } = await createTemporaryEngine();

    await engine.execute({ sql: "SELECT 1" });
    await engine.close();
    await engine.close();

    await expect(engine.execute({ sql: "SELECT 1" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
    await expect(engine.transaction(async () => 0)).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
  });

  test("isolates tenant databases from each other", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-tenants-"));
    temporaryDirectories.push(directory);
    const first = openSqliteEngine({
      databaseDirectory: directory,
      databasePath: join(directory, "tenant-a.sqlite"),
    });
    const second = openSqliteEngine({
      databaseDirectory: directory,
      databasePath: join(directory, "tenant-b.sqlite"),
    });
    engines.push(first, second);

    await first.execute({
      sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
    });
    await first.execute({ sql: "INSERT INTO notes (body) VALUES (?)", parameters: ["secret"] });

    const secondRows = await second.execute<{ count: number }>({
      sql: "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'notes'",
    });
    expect(secondRows.rows).toEqual([{ count: 0 }]);
    await expect(second.execute({ sql: "SELECT * FROM notes" })).rejects.toThrow();

    await first.close();
    await second.close();
  });

  test("rejects database paths outside the approved directory", () => {
    const directory = join(tmpdir(), "mekka-approved");
    temporaryDirectories.push(directory);

    expect(() =>
      openSqliteEngine({ databaseDirectory: directory, databasePath: "../escape.sqlite" }),
    ).toThrow(EngineError);
  });

  test("surfaces busy timeouts as typed engine errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-busy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "busy.sqlite");
    const engine = openSqliteEngine({ databaseDirectory: directory, databasePath });
    engines.push(engine);
    await engine.execute({ sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" });

    const { Database } = await import("bun:sqlite");
    const lock = new Database(databasePath, { strict: true });
    try {
      lock.run("BEGIN IMMEDIATE");
      await expect(engine.execute({ sql: "INSERT INTO t DEFAULT VALUES" })).rejects.toMatchObject({
        name: "EngineError",
        code: "ENGINE_BUSY",
      });
    } finally {
      lock.close();
    }
    await engine.close();
  });
});
