import { describe, expect, test } from "bun:test";
import { createTenantContext, parseTenantIdentity, type TenantContext } from "@mekka/protocol";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import { appendChangeEvents } from "../src/index";
import {
  createRealtimeSubscriptionGateway,
  type RealtimeSocket,
  type RealtimeSubscriptionSource,
} from "../src/subscriptions";

const tenant = parseTenantIdentity({
  organizationId: "org-main",
  projectId: "project-main",
  environmentId: "environment-main",
  branchId: "branch-main",
  generation: 1,
});

const otherTenant = parseTenantIdentity({
  organizationId: "org-other",
  projectId: "project-other",
  environmentId: "environment-other",
  branchId: "branch-other",
  generation: 1,
});

describe("Realtime subscriptions", () => {
  test("delivers only policy-authorized changes and requires an explicit acknowledgement", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    appendInsert(storage, tenant, "event_policy_alice", 1, "alice");
    appendInsert(storage, tenant, "event_policy_bob_01", 2, "bob");
    const fixture = createGatewayFixture(storage, { alice: context(tenant, "alice") });
    const socket = createSocket();

    try {
      fixture.gateway.open("connection-policy-01", socket);
      await fixture.gateway.receive("connection-policy-01", joinMessage("alice-access-token", 0));

      const changes = decodedEvents(socket).filter((message) => message[3] === "postgres_changes");
      expect(changes).toHaveLength(1);
      expect(changeData(changes[0])).toEqual(
        expect.objectContaining({ event_id: "event_policy_alice", record: { id: 1, body: "1" } }),
      );
      expect(JSON.stringify(changes)).not.toContain("bob");

      const cursor = readCursor(changes[0]);
      await fixture.gateway.receive("connection-policy-01", [
        "1",
        "2",
        "realtime:notes",
        "mekka_ack",
        { cursor },
      ]);
      expect(lastReply(socket).response).toEqual({ cursor: 2 });
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("replays an unacknowledged event after reconnect and resumes without a silent gap", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    appendInsert(storage, tenant, "event_resume_first", 1, "alice");
    const fixture = createGatewayFixture(storage, { alice: context(tenant, "alice") });
    const firstSocket = createSocket();
    const secondSocket = createSocket();

    try {
      fixture.gateway.open("connection-resume-01", firstSocket);
      await fixture.gateway.receive("connection-resume-01", joinMessage("alice-access-token", 0));
      const firstChange = decodedEvents(firstSocket).find(
        (message) => message[3] === "postgres_changes",
      );
      expect(changeData(firstChange).event_id).toBe("event_resume_first");

      fixture.gateway.close("connection-resume-01");
      fixture.gateway.open("connection-resume-02", secondSocket);
      await fixture.gateway.receive("connection-resume-02", joinMessage("alice-access-token", 0));
      const replay = decodedEvents(secondSocket).find(
        (message) => message[3] === "postgres_changes",
      );
      expect(changeData(replay).event_id).toBe("event_resume_first");

      const replayCursor = readCursor(replay);
      await fixture.gateway.receive("connection-resume-02", [
        "1",
        "2",
        "realtime:notes",
        "mekka_ack",
        { cursor: replayCursor },
      ]);
      appendInsert(storage, tenant, "event_resume_second", 2, "alice");
      await fixture.gateway.tick();
      expect(
        decodedEvents(secondSocket)
          .filter((message) => message[3] === "postgres_changes")
          .map((message) => changeData(message).event_id),
      ).toEqual(["event_resume_first", "event_resume_second"]);
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("fails closed for wrong tenant binding and closes an expired connection", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    let clock = 1_000_000;
    const fixture = createGatewayFixture(
      storage,
      {
        alice: context(tenant, "alice"),
        wrong: context(otherTenant, "alice"),
      },
      () => clock,
      1_001,
    );
    const wrongSocket = createSocket();
    const expiredSocket = createSocket();

    try {
      fixture.gateway.open("connection-wrong-01", wrongSocket);
      await fixture.gateway.receive("connection-wrong-01", joinMessage("wrong-access-token", 0));
      expect(wrongSocket.closed).toEqual({ code: 1008, reason: "tenant_mismatch" });

      fixture.gateway.open("connection-expiry-01", expiredSocket);
      await fixture.gateway.receive("connection-expiry-01", joinMessage("alice-access-token", 0));
      clock = 1_002_000;
      await fixture.gateway.tick();
      expect(expiredSocket.closed).toEqual({ code: 4001, reason: "token_expired" });
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("bounds a slow tenant without blocking an acknowledged neighbor", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    appendInsert(storage, tenant, "event_slow_first_01", 1, "alice");
    appendInsert(storage, tenant, "event_slow_second_1", 2, "alice");
    appendInsert(storage, otherTenant, "event_fast_first_01", 1, "carol");
    appendInsert(storage, otherTenant, "event_fast_second_1", 2, "carol");
    const fixture = createGatewayFixture(
      storage,
      {
        alice: context(tenant, "alice"),
        carol: context(otherTenant, "carol"),
      },
      Date.now,
      4_000_000_000,
      { maxUnackedEvents: 1, readBatchSize: 1 },
    );
    const slowSocket = createSocket();
    const fastSocket = createSocket();

    try {
      fixture.gateway.open("connection-slow-001", slowSocket);
      fixture.gateway.open("connection-fast-001", fastSocket);
      await fixture.gateway.receive("connection-slow-001", joinMessage("alice-access-token", 0));
      await fixture.gateway.receive("connection-fast-001", joinMessage("carol-access-token", 0));
      const fastFirst = decodedEvents(fastSocket).find(
        (message) => message[3] === "postgres_changes",
      );
      await fixture.gateway.receive("connection-fast-001", [
        "1",
        "2",
        "realtime:notes",
        "mekka_ack",
        { cursor: readCursor(fastFirst) },
      ]);

      await fixture.gateway.tick();

      expect(slowSocket.closed).toEqual({ code: 1013, reason: "slow_consumer" });
      expect(fastSocket.closed).toBeNull();
      expect(
        decodedEvents(fastSocket)
          .filter((message) => message[3] === "postgres_changes")
          .map((message) => changeData(message).event_id),
      ).toEqual(["event_fast_first_01", "event_fast_second_1"]);
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("enforces the tenant connection quota without closing an existing client", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    const fixture = createGatewayFixture(
      storage,
      { alice: context(tenant, "alice") },
      Date.now,
      4_000_000_000,
      { maxConnectionsPerTenant: 1 },
    );
    const firstSocket = createSocket();
    const secondSocket = createSocket();

    try {
      fixture.gateway.open("connection-quota-01", firstSocket);
      fixture.gateway.open("connection-quota-02", secondSocket);
      await fixture.gateway.receive("connection-quota-01", joinMessage("alice-access-token", 0));
      await fixture.gateway.receive("connection-quota-02", joinMessage("alice-access-token", 0));

      expect(firstSocket.closed).toBeNull();
      expect(secondSocket.closed).toEqual({ code: 1013, reason: "tenant_connection_quota" });
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("rejects concurrent joins for the same topic before authentication resolves", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    let resolveAuthentication:
      | ((value: { context: TenantContext; expiresAt: number }) => void)
      | null = null;
    const authentication = new Promise<{ context: TenantContext; expiresAt: number }>((resolve) => {
      resolveAuthentication = resolve;
    });
    const gateway = createRealtimeSubscriptionGateway({
      authenticate: () => authentication,
      resolveSource: (selectedContext) => createSource(storage, selectedContext.tenant),
    });
    const socket = createSocket();

    try {
      gateway.open("connection-race-001", socket);
      const firstJoin = gateway.receive(
        "connection-race-001",
        joinMessage("alice-access-token", 0),
      );
      await Promise.resolve();
      const secondJoin = gateway.receive(
        "connection-race-001",
        joinMessage("alice-access-token", 0),
      );
      resolveAuthentication?.({ context: context(tenant, "alice"), expiresAt: 4_000_000_000 });
      await Promise.all([firstJoin, secondJoin]);

      expect(socket.closed).toEqual({ code: 1008, reason: "invalid_channel" });
      expect(decodedEvents(socket).filter((message) => message[3] === "phx_reply")).toEqual([]);
    } finally {
      gateway.dispose();
      storage.close();
    }
  });
});

function createGatewayFixture(
  storage: StorageAdapter,
  contexts: Readonly<Record<string, TenantContext>>,
  now: () => number = Date.now,
  expiresAt = 4_000_000_000,
  limits:
    | Readonly<{
        maxConnectionsPerTenant?: number;
        maxUnackedEvents?: number;
        readBatchSize?: number;
      }>
    | undefined = undefined,
) {
  const gateway = createRealtimeSubscriptionGateway({
    authenticate(token) {
      const name = token.split("-", 1)[0];
      const selected = name === undefined ? undefined : contexts[name];
      if (selected === undefined) {
        throw new Error("invalid token");
      }
      return { context: selected, expiresAt };
    },
    resolveSource(selectedContext) {
      const sourceTenant = selectedContext === contexts.wrong ? tenant : selectedContext.tenant;
      return createSource(storage, sourceTenant);
    },
    now,
    ...(limits === undefined ? {} : { limits }),
  });
  return { gateway };
}

function createSource(
  storage: StorageAdapter,
  sourceTenant: typeof tenant,
): RealtimeSubscriptionSource {
  return {
    tenant: sourceTenant,
    storage,
    subscribableTables: ["notes"],
    authorizeChannel: () => null,
    authorize(contextValue, _event, _oldRecord, record) {
      if (record?.owner_id !== contextValue.actor.id) {
        return null;
      }
      return {
        oldRecord: null,
        record: { id: record.id ?? null, body: record.body ?? null },
      };
    },
  };
}

function createSocket(): RealtimeSocket & {
  messages: string[];
  closed: Readonly<{ code: number; reason: string }> | null;
} {
  const socket = {
    messages: [] as string[],
    closed: null as Readonly<{ code: number; reason: string }> | null,
    send(message: string) {
      socket.messages.push(message);
      return "sent" as const;
    },
    close(code: number, reason: string) {
      socket.closed = Object.freeze({ code, reason });
    },
  };
  return socket;
}

function appendInsert(
  storage: StorageAdapter,
  selectedTenant: typeof tenant,
  eventId: string,
  id: number,
  ownerId: string,
): void {
  storage.transaction((transaction) => {
    appendChangeEvents(transaction, {
      tenant: selectedTenant,
      transactionId: `transaction_${eventId}`,
      occurredAt: 1_000_000 + id,
      changes: [
        {
          eventId,
          operation: "INSERT",
          table: "notes",
          oldRecord: null,
          record: { id, body: String(id) },
          policyOldRecord: null,
          policyRecord: { id, owner_id: ownerId, body: String(id), private_note: "secret" },
        },
      ],
    });
  });
}

function context(selectedTenant: typeof tenant, actorId: string): TenantContext {
  return createTenantContext({
    tenant: selectedTenant,
    actor: { kind: "user", id: actorId },
    capabilities: [],
    correlationId: "018e6c28-0000-7000-8000-000000000001",
  });
}

function joinMessage(token: string, cursor: number) {
  return [
    null,
    "1",
    "realtime:notes",
    "phx_join",
    {
      access_token: token,
      cursor,
      config: {
        postgres_changes: [{ event: "*", schema: "public", table: "notes" }],
      },
    },
  ];
}

type DecodedMessage = [string | null, string | null, string, string, Record<string, unknown>];

function decodedEvents(socket: { messages: string[] }): DecodedMessage[] {
  return socket.messages.map((message) => JSON.parse(message) as DecodedMessage);
}

function changeData(message: DecodedMessage | undefined): Record<string, unknown> {
  const payload = message?.[4];
  const data = payload?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Expected change data.");
  }
  return data as Record<string, unknown>;
}

function readCursor(message: DecodedMessage | undefined): number {
  const cursor = changeData(message).cursor;
  if (typeof cursor !== "number") {
    throw new Error("Expected cursor.");
  }
  return cursor;
}

function lastReply(socket: { messages: string[] }): Record<string, unknown> {
  const reply = decodedEvents(socket)
    .filter((message) => message[3] === "phx_reply")
    .at(-1)?.[4];
  if (reply === undefined || typeof reply.response !== "object" || reply.response === null) {
    throw new Error("Expected reply.");
  }
  return reply;
}
