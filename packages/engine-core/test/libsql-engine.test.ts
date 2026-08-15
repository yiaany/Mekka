import { afterEach, describe, expect, test } from "bun:test";
import { type Engine, EngineError, openLibsqlEngine, testLibsqlConnection } from "../src/index";

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
  setHang(match: (request: RecordedRequest) => boolean): void;
}>;

const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close().catch(() => undefined)));
});

function createStubTransport(): StubTransport {
  const requests: RecordedRequest[] = [];
  let failure: { status: number; body: string } | null = null;
  let hang: ((request: RecordedRequest) => boolean) | null = null;

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

    if (hang?.(recorded)) {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error(`Aborted after signal; url=${recorded.url}`));
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (failure !== null) {
      return new Response(failure.body, {
        status: failure.status,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "GET") {
      return new Response(null, { status: 404 });
    }

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
        response: {
          type: "execute",
          result: statementResult(entry.stmt?.sql ?? ""),
        },
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
    setHang(match: (request: RecordedRequest) => boolean) {
      hang = match;
    },
  };
}

function statementResult(sql: string): unknown {
  if (/SELECT sqlite_version/.test(sql)) {
    return {
      cols: [{ name: "version", decltype: null }],
      rows: [[{ type: "text", value: "3.45.1" }]],
      affected_row_count: 0,
    };
  }
  return {
    cols: [{ name: "id", decltype: null }],
    rows: [[{ type: "integer", value: "1" }]],
    affected_row_count: 1,
    last_insert_rowid: "5",
  };
}

function openTestEngine(
  transport: StubTransport,
  options: Partial<Parameters<typeof openLibsqlEngine>[0]> = {},
): Engine {
  const engine = openLibsqlEngine({
    url: "https://engine.test",
    requestTimeoutMs: 200,
    fetch: transport.fetch,
    ...options,
  });
  engines.push(engine);
  return engine;
}

function pipelineRequests(transport: StubTransport): PipelineRequest[] {
  return transport.requests
    .filter((request) => request.method === "POST")
    .flatMap(
      (request) => (request.body as { requests?: PipelineRequest[] } | null)?.requests ?? [],
    );
}

function sentSql(transport: StubTransport): string[] {
  return pipelineRequests(transport).flatMap((entry) => {
    if (entry.type === "batch") {
      return (entry.batch?.steps ?? [])
        .map((step) => step?.stmt?.sql ?? "")
        .filter((sql) => sql.length > 0);
    }
    return entry.stmt?.sql ? [entry.stmt.sql] : [];
  });
}

describe("libsql engine contract", () => {
  test("exposes engineKind and remote capabilities", () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

    expect(engine.engineKind).toBe("libsql-remote");
    expect(engine.capabilities).toEqual({
      transactions: true,
      dialect: "sqlite",
      remote: true,
    });
    expect(Object.isFrozen(engine.capabilities)).toBe(true);
  });

  test("executes parameterized statements and normalizes rows, changes and lastInsertRowid", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

    const result = await engine.execute<{ id: number }>({
      sql: "SELECT id FROM accounts WHERE name = ?",
      parameters: ["Ada'; DROP TABLE accounts; --"],
    });

    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.changes).toBe(1);
    expect(result.lastInsertRowid).toBe(5);

    const statement = pipelineRequests(transport)[0]?.stmt;
    expect(statement?.sql).toBe("SELECT id FROM accounts WHERE name = ?");
    expect(statement?.args).toEqual([{ type: "text", value: "Ada'; DROP TABLE accounts; --" }]);
  });

  test("sends the server-side token only as an authorization header", async () => {
    const previous = process.env.MEKKA_TEST_LIBSQL_TOKEN;
    process.env.MEKKA_TEST_LIBSQL_TOKEN = "supersecret-server-token";
    try {
      const transport = createStubTransport();
      const engine = openTestEngine(transport, { tokenReference: "MEKKA_TEST_LIBSQL_TOKEN" });
      await engine.execute({ sql: "SELECT 1" });

      const pipeline = transport.requests.find((request) => request.method === "POST");
      expect(pipeline?.authorization).toBe("Bearer supersecret-server-token");
    } finally {
      if (previous === undefined) delete process.env.MEKKA_TEST_LIBSQL_TOKEN;
      else process.env.MEKKA_TEST_LIBSQL_TOKEN = previous;
    }
  });

  test("never leaks the token through errors or connection results", async () => {
    const previous = process.env.MEKKA_TEST_LIBSQL_TOKEN;
    process.env.MEKKA_TEST_LIBSQL_TOKEN = "supersecret-server-token";
    try {
      const transport = createStubTransport();
      transport.setFailure(401, JSON.stringify({ error: "unauthorized" }));
      const engine = openTestEngine(transport, { tokenReference: "MEKKA_TEST_LIBSQL_TOKEN" });

      const caught = await engine.execute({ sql: "SELECT 1" }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(EngineError);
      expect((caught as EngineError).code).toBe("ENGINE_AUTH");
      expect((caught as Error).message).not.toContain("supersecret-server-token");
      expect(JSON.stringify(caught)).not.toContain("supersecret-server-token");

      const testResult = await testLibsqlConnection({
        url: "https://engine.test",
        tokenReference: "MEKKA_TEST_LIBSQL_TOKEN",
        requestTimeoutMs: 200,
        fetch: transport.fetch,
      });
      expect(testResult.ok).toBe(false);
      if (!testResult.ok) {
        expect(testResult.error.code).toBe("ENGINE_AUTH");
        expect(testResult.error.message).not.toContain("supersecret-server-token");
      }
    } finally {
      if (previous === undefined) delete process.env.MEKKA_TEST_LIBSQL_TOKEN;
      else process.env.MEKKA_TEST_LIBSQL_TOKEN = previous;
    }
  });

  test("rejects unsafe URLs and missing token references before any request", () => {
    expect(() =>
      openLibsqlEngine({ url: "ws://engine.test", fetch: createStubTransport().fetch }),
    ).toThrow(/scheme/);
    expect(() =>
      openLibsqlEngine({
        url: "https://user:pass@engine.test",
        fetch: createStubTransport().fetch,
      }),
    ).toThrow(/credentials/);
    expect(() =>
      openLibsqlEngine({ url: "https://engine.test?token=x", fetch: createStubTransport().fetch }),
    ).toThrow(/query/);
    expect(() =>
      openLibsqlEngine({ url: "http://engine.test", fetch: createStubTransport().fetch }),
    ).toThrow(/loopback/);
    expect(() =>
      openLibsqlEngine({
        url: "https://engine.test",
        tokenReference: "MEKKA_TEST_LIBSQL_MISSING",
        fetch: createStubTransport().fetch,
      }),
    ).toThrow(/does not resolve/);
    expect(() =>
      openLibsqlEngine({
        url: "https://engine.test",
        requestTimeoutMs: 0,
        fetch: createStubTransport().fetch,
      }),
    ).toThrow(/requestTimeoutMs/);
  });

  test("allows http loopback URLs in explicit localhost development mode", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport, {
      url: "http://127.0.0.1:3002",
      allowLocalhost: true,
    });
    const result = await engine.execute<{ id: number }>({ sql: "SELECT 1" });
    expect(result.rows).toEqual([{ id: 1 }]);
  });

  test("commits a transaction and rolls back when the callback throws", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

    await engine.transaction(async (tx) => {
      await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", parameters: [10] });
    });

    await expect(
      engine.transaction(async (tx) => {
        await tx.execute({ sql: "INSERT INTO t (v) VALUES (?)", parameters: [20] });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const sql = sentSql(transport);
    expect(sql.filter((entry) => entry.startsWith("BEGIN IMMEDIATE"))).toHaveLength(2);
    expect(sql.filter((entry) => entry.startsWith("COMMIT"))).toHaveLength(1);
    expect(sql.filter((entry) => entry.startsWith("ROLLBACK"))).toHaveLength(1);
  });

  test("rejects nested transactions", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

    await expect(
      engine.transaction(async (tx) => {
        await tx.execute({ sql: "SELECT 1" });
        await engine.transaction(async (inner) => {
          await inner.execute({ sql: "SELECT 2" });
        });
      }),
    ).rejects.toMatchObject({ name: "EngineError", code: "ENGINE_FAILED" });
  });

  test("maps auth, conflict, unavailable and timeout HTTP failures to typed errors", async () => {
    const cases: Array<{ status: number; expected: string }> = [
      { status: 401, expected: "ENGINE_AUTH" },
      { status: 403, expected: "ENGINE_AUTH" },
      { status: 409, expected: "ENGINE_CONFLICT" },
      { status: 500, expected: "ENGINE_UNAVAILABLE" },
      { status: 504, expected: "ENGINE_TIMEOUT" },
    ];
    for (const scenario of cases) {
      const transport = createStubTransport();
      transport.setFailure(scenario.status, JSON.stringify({ error: "server error" }));
      const engine = openTestEngine(transport);
      const caught = await engine.execute({ sql: "SELECT 1" }).catch((error: unknown) => error);
      expect(caught, `status ${scenario.status}`).toBeInstanceOf(EngineError);
      expect((caught as EngineError).code, `status ${scenario.status}`).toBe(scenario.expected);
    }
  });

  test("rejects forbidden statements with a typed engine error before any request", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

    await expect(engine.execute({ sql: "BEGIN IMMEDIATE" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_STATEMENT_FORBIDDEN",
    });
    await expect(engine.execute({ sql: "SELECT 1; SELECT 2" })).rejects.toMatchObject({
      name: "EngineError",
      code: "ENGINE_STATEMENT_FORBIDDEN",
    });
    expect(transport.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  test("times out bounded requests and retries read-only statements exactly once on safe failures", async () => {
    const transport = createStubTransport();
    let hangs = 0;
    transport.setHang((request) => {
      if (request.method !== "POST") return false;
      hangs += 1;
      return true;
    });
    const engine = openTestEngine(transport, { requestTimeoutMs: 50 });

    const caught = await engine.execute({ sql: "SELECT 1" }).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineError);
    expect((caught as EngineError).code).toBe("ENGINE_TIMEOUT");
    expect(hangs).toBe(2);
  });

  test("never retries mutations on safe failures", async () => {
    const transport = createStubTransport();
    let hangs = 0;
    transport.setHang((request) => {
      if (request.method !== "POST") return false;
      hangs += 1;
      return true;
    });
    const engine = openTestEngine(transport, { requestTimeoutMs: 50 });

    const caught = await engine
      .execute({ sql: "INSERT INTO t (v) VALUES (?)", parameters: [1] })
      .catch((error: unknown) => error);
    expect((caught as EngineError).code).toBe("ENGINE_TIMEOUT");
    expect(hangs).toBe(1);
  });

  test("testLibsqlConnection reports version and latency on success and typed errors on failure", async () => {
    const okTransport = createStubTransport();
    const okResult = await testLibsqlConnection({
      url: "https://engine.test",
      requestTimeoutMs: 200,
      fetch: okTransport.fetch,
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.engineVersion).toBe("3.45.1");
      expect(okResult.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const authTransport = createStubTransport();
    authTransport.setFailure(401, JSON.stringify({ error: "unauthorized" }));
    const authResult = await testLibsqlConnection({
      url: "https://engine.test",
      requestTimeoutMs: 200,
      fetch: authTransport.fetch,
    });
    expect(authResult.ok).toBe(false);
    if (!authResult.ok) {
      expect(authResult.error.code).toBe("ENGINE_AUTH");
    }

    const timeoutTransport = createStubTransport();
    timeoutTransport.setHang((request) => request.method === "POST");
    const timeoutResult = await testLibsqlConnection({
      url: "https://engine.test",
      requestTimeoutMs: 50,
      fetch: timeoutTransport.fetch,
    });
    expect(timeoutResult.ok).toBe(false);
    if (!timeoutResult.ok) {
      expect(timeoutResult.error.code).toBe("ENGINE_TIMEOUT");
    }
  });

  test("close twice is safe and execute after close fails closed", async () => {
    const transport = createStubTransport();
    const engine = openTestEngine(transport);

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
});
