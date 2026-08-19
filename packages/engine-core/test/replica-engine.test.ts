import { afterEach, describe, expect, test } from "bun:test";
import {
  type EngineResult,
  EngineError,
  type EngineStatement,
  type EngineValue,
  openReplicaLibsqlEngine,
  routeReplicaLibsqlOperation,
  type LibsqlOperationEvent,
  type ReplicaLibsqlEngine,
  type ReplicaLibsqlReplicaDriver,
} from "../src/index";

type RecordedRequest = Readonly<{
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}>;

type PipelineRequest = Readonly<{
  type?: "execute" | "batch";
  stmt?: Readonly<{ sql?: string; args?: unknown[] }>;
  batch?: Readonly<{ steps: readonly (Readonly<{ stmt?: { sql?: string } }> | null)[] }>;
}>;

type StubTransport = Readonly<{
  fetch: typeof fetch;
  requests: RecordedRequest[];
  setFailure(status: number | null, body?: string): void;
}>;

type StubReplicaDriver = Readonly<{
  driver: ReplicaLibsqlReplicaDriver;
  executedSql: string[];
  getSyncCount(): number;
  isClosed(): boolean;
  setReads(readRows: readonly Record<string, EngineValue>[]): void;
  setSyncBehavior(behavior: "ok" | "fail" | "hang"): void;
  setReadBehavior(behavior: "ok" | "fail"): void;
  setSyncError(error: Error, failures: number): void;
  setReadError(error: Error | null): void;
}>;

const engines: ReplicaLibsqlEngine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close().catch(() => undefined)));
});

function createStubTransport(): StubTransport {
  const requests: RecordedRequest[] = [];
  let failure: { status: number; body: string } | null = null;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: request.method === "GET" ? null : (await request.text().catch(() => "")) || null,
    };
    if (recorded.body !== null) {
      try {
        recorded.body = JSON.parse(recorded.body as string);
      } catch {
        recorded.body = null;
      }
    }
    requests.push(recorded);
    if (failure !== null) {
      return new Response(failure.body, {
        status: failure.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (request.method === "GET") return new Response(null, { status: 404 });
    const pipeline = recorded.body as { requests?: PipelineRequest[] } | null;
    const results = (pipeline?.requests ?? []).map((entry) => {
      if (entry.type === "close" || entry.type === "store_sql") {
        return { type: "ok", response: { type: entry.type } };
      }
      if (entry.type === "batch") {
        return {
          type: "ok",
          response: {
            type: "batch",
            result: {
              step_results: (entry.batch?.steps ?? []).map((step) =>
                step === null ? null : statementResult(step.stmt?.sql ?? ""),
              ),
              step_errors: (entry.batch?.steps ?? []).map(() => null),
            },
          },
        };
      }
      return {
        type: "ok",
        response: { type: "execute", result: statementResult(entry.stmt?.sql ?? "") },
      };
    });
    return new Response(JSON.stringify({ baton: "b1", base_url: "http://engine.test", results }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch,
    requests,
    setFailure(status: number | null, body?: string) {
      failure = status === null ? null : { status, body: body ?? '{"error":"unavailable"}' };
    },
  };
}

function statementResult(sql: string): unknown {
  if (/SELECT.*replica_row/.test(sql)) {
    return {
      cols: [{ name: "replica_row", decltype: null }],
      rows: [[{ type: "text", value: "1" }]],
      affected_row_count: 0,
    };
  }
  return {
    cols: [{ name: "primary_row", decltype: null }],
    rows: [[{ type: "text", value: sql.startsWith("INSERT") ? "inserted" : "primary" }]],
    affected_row_count: 1,
    last_insert_rowid: "7",
  };
}

function createStubReplicaDriver(): StubReplicaDriver {
  const executedSql: string[] = [];
  let reads: readonly Record<string, EngineValue>[] = [];
  let syncBehavior: "ok" | "fail" | "hang" = "ok";
  let readBehavior: "ok" | "fail" = "ok";
  let syncFailures = 0;
  let syncError: Error | null = null;
  let readError: Error | null = null;
  let syncCount = 0;
  let closed = false;
  const driver: ReplicaLibsqlReplicaDriver = {
    execute: async <Row extends Record<string, EngineValue>>(
      statement: EngineStatement,
    ): Promise<EngineResult<Row>> => {
      executedSql.push(statement.sql);
      if (readError !== null) throw readError;
      if (readBehavior === "fail") {
        throw new EngineError("ENGINE_UNAVAILABLE", "Replica read failed.");
      }
      return Object.freeze({
        rows: Object.freeze(reads) as readonly Row[],
        changes: 0,
        lastInsertRowid: 0n,
      });
    },
    sync: async () => {
      syncCount += 1;
      if (syncFailures > 0) {
        syncFailures -= 1;
        throw syncError ?? new Error("Replica sync failed.");
      }
      if (syncBehavior === "fail") throw new Error("Replica sync failed.");
      if (syncBehavior === "hang") await new Promise<void>(() => undefined);
    },
    close: () => {
      closed = true;
    },
  };
  return {
    driver,
    executedSql,
    getSyncCount: () => syncCount,
    isClosed: () => closed,
    setReads(next: readonly Record<string, EngineValue>[]) {
      reads = next;
    },
    setSyncBehavior(behavior: "ok" | "fail" | "hang") {
      syncBehavior = behavior;
    },
    setReadBehavior(behavior: "ok" | "fail") {
      readBehavior = behavior;
    },
    setSyncError(error: Error, failures: number) {
      syncError = error;
      syncFailures = failures;
    },
    setReadError(error: Error | null) {
      readError = error;
    },
  };
}

function openTestEngine(
  transport: StubTransport,
  driver: StubReplicaDriver,
  options: Partial<
    Readonly<{
      fallbackPolicy: "primary" | "safe-error";
      syncOnOpen: boolean;
      syncIntervalMs: number;
      syncRetryDelayMs: number;
      now: () => number;
      onOperation: (event: LibsqlOperationEvent) => void;
    }>
  > = {},
): ReplicaLibsqlEngine {
  const engine = openReplicaLibsqlEngine({
    primary: {
      url: "https://engine.test",
      requestTimeoutMs: 200,
      fetch: transport.fetch,
    },
    replicaPath: "C:\\tmp\\replica.db",
    fallbackPolicy: options.fallbackPolicy ?? "safe-error",
    syncOnOpen: options.syncOnOpen ?? true,
    ...(options.syncIntervalMs === undefined ? {} : { syncIntervalMs: options.syncIntervalMs }),
    ...(options.syncRetryDelayMs === undefined
      ? {}
      : { syncRetryDelayMs: options.syncRetryDelayMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onOperation === undefined ? {} : { onOperation: options.onOperation }),
    createReplicaDriver: () => driver.driver,
  });
  engines.push(engine);
  return engine;
}

function sentSql(transport: StubTransport): string[] {
  return transport.requests
    .filter((request) => request.method === "POST")
    .flatMap((request) => {
      const pipeline = (request.body as { requests?: PipelineRequest[] } | null)?.requests ?? [];
      return pipeline.flatMap((entry) => {
        if (entry.type === "batch") {
          return (entry.batch?.steps ?? [])
            .map((step) => step?.stmt?.sql ?? "")
            .filter((sql) => sql.length > 0);
        }
        return entry.stmt?.sql ? [entry.stmt.sql] : [];
      });
    });
}

describe("libsql-replica engine contract", () => {
  test("exposes the replica profile with remote capabilities", () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver);

    expect(engine.engineKind).toBe("libsql-replica");
    expect(engine.capabilities).toEqual({ transactions: true, dialect: "sqlite", remote: true });
    expect(Object.isFrozen(engine.capabilities)).toBe(true);
  });

  test("a typed read is answered by the local replica, never by the primary", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setReads([{ id: 1, name: "from-replica" }]);
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();

    const result = await engine.executeTypedRead<{ id: number; name: string }>({
      sql: "SELECT id, name FROM accounts",
    });

    expect(result.rows).toEqual([{ id: 1, name: "from-replica" }]);
    expect(driver.executedSql).toEqual(["SELECT id, name FROM accounts"]);
    expect(transport.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("a write, raw SQL and DDL always go to the primary", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();

    await engine.executeTypedWrite({
      sql: "INSERT INTO accounts (name) VALUES (?)",
      parameters: ["Ada"],
    });
    await engine.execute({ sql: "CREATE TABLE t (id INTEGER)" });
    await engine.execute({ sql: "SELECT * FROM arbitrary_raw" });

    const sql = sentSql(transport);
    expect(sql).toContain("INSERT INTO accounts (name) VALUES (?)");
    expect(sql).toContain("CREATE TABLE t (id INTEGER)");
    expect(sql).toContain("SELECT * FROM arbitrary_raw");
    expect(driver.executedSql).toEqual([]);
  });

  test("routeReplicaLibsqlOperation dispatches by explicit kind without inspecting SQL", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setReads([{ id: 1 }]);
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();

    await routeReplicaLibsqlOperation(engine, {
      kind: "typed-read",
      statement: { sql: "SELECT 1" },
    });
    await routeReplicaLibsqlOperation(engine, {
      kind: "typed-write",
      statement: { sql: "INSERT INTO t (v) VALUES (1)" },
    });
    await routeReplicaLibsqlOperation(engine, {
      kind: "ddl",
      statement: { sql: "CREATE TABLE t (id INTEGER)" },
    });
    await routeReplicaLibsqlOperation(engine, {
      kind: "migration",
      statement: { sql: "ALTER TABLE t ADD COLUMN v" },
    });
    await routeReplicaLibsqlOperation(engine, {
      kind: "raw",
      statement: { sql: "SELECT * FROM raw_meta" },
    });

    expect(driver.executedSql).toEqual(["SELECT 1"]);
    const primary = sentSql(transport);
    expect(primary).toContain("INSERT INTO t (v) VALUES (1)");
    expect(primary).toContain("CREATE TABLE t (id INTEGER)");
    expect(primary).toContain("ALTER TABLE t ADD COLUMN v");
    expect(primary).toContain("SELECT * FROM raw_meta");
  });

  test("after a write the current session reads the primary again (read-your-writes)", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setReads([{ version: "old-replica" }]);
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();

    const before = await engine.executeTypedRead<{ version: string }>({
      sql: "SELECT version FROM state",
    });
    expect(before.rows).toEqual([{ version: "old-replica" }]);
    expect(driver.executedSql).toHaveLength(1);

    await engine.executeTypedWrite({ sql: "INSERT INTO changes (v) VALUES (1)" });

    const after = await engine.executeTypedRead<{ version: string }>(
      { sql: "SELECT version FROM state" },
      { readYourWrites: true },
    );
    expect(after.rows[0]?.primary_row).toContain("primary");

    expect(engine.status().state).toBe("stale");
    const primarySql = sentSql(transport);
    expect(primarySql).toContain("SELECT version FROM state");
  });

  test("manual sync refreshes a stale replica and restores the read path", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();
    expect(engine.status().state).toBe("ready");

    await engine.executeTypedWrite({ sql: "INSERT INTO t (v) VALUES (1)" });
    expect(engine.status().state).toBe("stale");

    const synced = await engine.syncNow();
    expect(synced.ok).toBe(true);
    expect(synced.state).toBe("ready");
    expect(engine.status().lastSyncAtMs).toBeGreaterThanOrEqual(0);

    await engine.executeTypedRead({ sql: "SELECT 1" });
    expect(driver.executedSql).toEqual(["SELECT 1"]);
  });

  test("the timed sync stays off by default and is bounded and closed with the adapter", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver, { syncIntervalMs: 0, syncOnOpen: false });
    await engine.syncNow();
    expect(driver.getSyncCount()).toBe(1);

    expect(() =>
      openReplicaLibsqlEngine({
        primary: { url: "https://engine.test", fetch: createStubTransport().fetch },
        replicaPath: "C:\\tmp\\replica.db",
        fallbackPolicy: "safe-error",
        syncOnOpen: false,
        syncIntervalMs: 4_000_000,
      }),
    ).toThrow(/syncIntervalMs/);
  });

  test("replica unavailable falls back to primary or returns a safe error by explicit policy", async () => {
    const primaryTransport = createStubTransport();
    const failingDriver = createStubReplicaDriver();
    failingDriver.setReadBehavior("fail");
    const primaryFallback = openTestEngine(primaryTransport, failingDriver, {
      fallbackPolicy: "primary",
    });
    await primaryFallback.syncNow();

    const result = await primaryFallback.executeTypedRead({ sql: "SELECT * FROM accounts" });
    expect(result.rows[0]?.primary_row).toBeDefined();
    expect(sentSql(primaryTransport)).toContain("SELECT * FROM accounts");
    expect(primaryFallback.status().state).toBe("unavailable");

    const safeTransport = createStubTransport();
    const safeDriver = createStubReplicaDriver();
    safeDriver.setReadBehavior("fail");
    const safeError = openTestEngine(safeTransport, safeDriver, { fallbackPolicy: "safe-error" });
    await safeError.syncNow();

    await expect(
      safeError.executeTypedRead({ sql: "SELECT * FROM accounts" }),
    ).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_UNAVAILABLE",
    });
    expect(sentSql(safeTransport)).toHaveLength(0);
  });

  test("a failed sync marks the replica unavailable until a successful sync", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setSyncBehavior("fail");
    const engine = openTestEngine(transport, driver);

    const result = await engine.syncNow();
    expect(result.ok).toBe(false);
    expect(engine.status().state).toBe("unavailable");

    driver.setSyncBehavior("ok");
    const retried = await engine.syncNow();
    expect(retried.ok).toBe(true);
    expect(engine.status().state).toBe("ready");
  });

  test("close stops the replica timer and closes the driver without active handles", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver, { syncIntervalMs: 1_000 });

    await engine.syncNow();
    await engine.close();
    await engine.close();

    expect(driver.isClosed()).toBe(true);
    await expect(engine.executeTypedRead({ sql: "SELECT 1" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
    await expect(engine.syncNow()).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
  });

  test("closes fail closed for writes, transactions and raw SQL after shutdown", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    const engine = openTestEngine(transport, driver);
    await engine.syncNow();
    await engine.close();

    await expect(engine.execute({ sql: "INSERT INTO t (v) VALUES (1)" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
    await expect(engine.transaction(async () => 0)).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_CLOSED",
    });
  });

  test("a driver that fails to create leaves the replica unavailable while the primary stays usable", async () => {
    const transport = createStubTransport();
    const engine = openReplicaLibsqlEngine({
      primary: {
        url: "https://engine.test",
        requestTimeoutMs: 200,
        fetch: transport.fetch,
      },
      replicaPath: "C:\\tmp\\replica.db",
      fallbackPolicy: "primary",
      syncOnOpen: false,
      createReplicaDriver: () => {
        throw new Error("dns resolution failed");
      },
    });
    engines.push(engine);

    const synced = await engine.syncNow();
    expect(synced.ok).toBe(false);
    expect(engine.status().state).toBe("unavailable");

    const read = await engine.executeTypedRead({ sql: "SELECT 1" });
    expect(read.rows[0]?.primary_row).toBeDefined();
    expect(sentSql(transport)).toContain("SELECT 1");

    await engine.executeTypedWrite({ sql: "INSERT INTO t (v) VALUES (1)" });
    expect(engine.status().state).toBe("unavailable");

    await engine.close();
    await engine.close();
  });

  test("a failed driver with safe-error policy rejects reads honestly without crashing", async () => {
    const safeTransport = createStubTransport();
    const safeEngine = openReplicaLibsqlEngine({
      primary: {
        url: "https://engine.test",
        requestTimeoutMs: 200,
        fetch: safeTransport.fetch,
      },
      replicaPath: "C:\\tmp\\replica.db",
      fallbackPolicy: "safe-error",
      syncOnOpen: false,
      createReplicaDriver: () => {
        throw new Error("dns resolution failed");
      },
    });
    engines.push(safeEngine);

    const synced = await safeEngine.syncNow();
    expect(synced.ok).toBe(false);

    await expect(safeEngine.executeTypedRead({ sql: "SELECT 1" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_UNAVAILABLE",
    });

    await safeEngine.close();
  });

  test("sync retries a transport-level failure once with bounded backoff and recovers", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setSyncError(new TypeError("socket hang up"), 1);
    const engine = openTestEngine(transport, driver, {
      syncOnOpen: false,
      syncRetryDelayMs: 0,
    });

    const result = await engine.syncNow();
    expect(result.ok).toBe(true);
    expect(result.state).toBe("ready");
    expect(driver.getSyncCount()).toBe(2);
  });

  test("sync bounds its retries and reports the typed transport failure", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setSyncError(new TypeError("socket hang up"), 2);
    const events: LibsqlOperationEvent[] = [];
    const engine = openTestEngine(transport, driver, {
      syncOnOpen: false,
      syncRetryDelayMs: 0,
      onOperation: (event) => events.push(event),
    });

    const result = await engine.syncNow();
    expect(result.ok).toBe(false);
    expect(driver.getSyncCount()).toBe(2);
    expect(engine.status().state).toBe("unavailable");
    expect(result.error?.code).toBe("ENGINE_UNAVAILABLE");
    expect(result.error?.outcome).toBe("unknown");
    expect(result.error?.operationId).not.toBeNull();
    expect(events[0]).toMatchObject({
      route: "replica-sync",
      outcome: "unknown",
      errorCode: "ENGINE_UNAVAILABLE",
      attempts: 2,
    });
    expect(JSON.stringify(events)).not.toContain("engine.test");
  });

  test("sync never retries deterministic failures", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setSyncError(new EngineError("ENGINE_AUTH", "Replica sync was rejected."), 1);
    const engine = openTestEngine(transport, driver, { syncOnOpen: false, syncRetryDelayMs: 0 });

    const result = await engine.syncNow();
    expect(result.ok).toBe(false);
    expect(driver.getSyncCount()).toBe(1);
    expect(result.error?.code).toBe("ENGINE_AUTH");
    expect(result.error?.outcome).toBe("failed");
  });

  test("replica read failures classify outcomes and emit signals without SQL", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setReadError(new TypeError("socket hang up"));
    const events: LibsqlOperationEvent[] = [];
    const engine = openTestEngine(transport, driver, {
      syncOnOpen: true,
      onOperation: (event) => events.push(event),
    });
    await engine.syncNow();

    const caught = (await engine
      .executeTypedRead({ sql: "SELECT id, secret FROM accounts" })
      .catch((error: unknown) => error)) as EngineError;
    expect(caught.code).toBe("ENGINE_UNAVAILABLE");
    expect(caught.outcome).toBe("unknown");
    expect(caught.operationId).not.toBeNull();

    const readEvents = events.filter((event) => event.route === "replica-read");
    expect(readEvents[0]).toMatchObject({
      outcome: "unknown",
      errorCode: "ENGINE_UNAVAILABLE",
      attempts: 1,
    });
    expect(JSON.stringify(readEvents)).not.toContain("SELECT");
    expect(JSON.stringify(readEvents)).not.toContain("secret");
  });

  test("replica read events are emitted for successful local reads", async () => {
    const transport = createStubTransport();
    const driver = createStubReplicaDriver();
    driver.setReads([{ id: 1 }]);
    const events: LibsqlOperationEvent[] = [];
    const engine = openTestEngine(transport, driver, {
      onOperation: (event) => events.push(event),
    });
    await engine.syncNow();

    await engine.executeTypedRead({ sql: "SELECT id FROM accounts" });

    expect(events.filter((event) => event.route === "replica-read")[0]).toMatchObject({
      outcome: "ok",
      errorCode: null,
      attempts: 1,
    });
  });

  test("syncRetryDelayMs is validated and bounded", () => {
    expect(() =>
      openReplicaLibsqlEngine({
        primary: { url: "https://engine.test", fetch: createStubTransport().fetch },
        replicaPath: "C:\\tmp\\replica.db",
        fallbackPolicy: "safe-error",
        syncOnOpen: false,
        syncRetryDelayMs: 6_000,
      }),
    ).toThrow(/syncRetryDelayMs/);
  });
});
