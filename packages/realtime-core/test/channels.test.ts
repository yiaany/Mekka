import { describe, expect, test } from "bun:test";
import { createTenantContext, parseTenantIdentity, type TenantContext } from "@mekka/protocol";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import { createInMemoryRealtimeChannelCoordinator } from "../src/channels";
import {
  createRealtimeSubscriptionGateway,
  type RealtimeSocket,
  type RealtimeSubscriptionLimits,
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

describe("Realtime Broadcast and Presence", () => {
  test("coordinates broadcast and consistent presence across gateway instances", async () => {
    const coordinator = createInMemoryRealtimeChannelCoordinator();
    const firstStorage = openStorageAdapter({ databasePath: ":memory:" });
    const secondStorage = openStorageAdapter({ databasePath: ":memory:" });
    const contexts = {
      alice: context(tenant, "alice"),
      bob: context(tenant, "bob"),
    };
    const first = createFixture(firstStorage, contexts, { coordinator });
    const second = createFixture(secondStorage, contexts, { coordinator });
    const alice = createSocket();
    const bob = createSocket();

    try {
      first.gateway.open("connection-alice-01", alice);
      second.gateway.open("connection-bob-0001", bob);
      await first.gateway.receive("connection-alice-01", joinMessage("alice", true));
      await second.gateway.receive("connection-bob-0001", joinMessage("bob", true));
      expect(eventPayloads(alice, "presence_state").at(-1)).toEqual({});
      expect(eventPayloads(bob, "presence_state").at(-1)).toEqual({});

      await first.gateway.receive(
        "connection-alice-01",
        presenceMessage("2", "track", { status: "online" }),
      );
      expect(eventPayloads(bob, "presence_diff").at(-1)).toEqual({
        joins: {
          alice: {
            metas: [expect.objectContaining({ actor_id: "alice", status: "online" })],
          },
        },
        leaves: {},
      });

      await second.gateway.receive(
        "connection-bob-0001",
        broadcastMessage("3", "cursor-pos", { x: 10 }),
      );
      expect(eventPayloads(alice, "broadcast").at(-1)).toEqual({
        type: "broadcast",
        event: "cursor-pos",
        payload: { x: 10 },
      });
      expect(eventPayloads(bob, "broadcast")).toHaveLength(0);
      expect(replyFor(bob, "3")).toEqual({ status: "ok", response: {} });
    } finally {
      first.gateway.dispose();
      second.gateway.dispose();
      coordinator.dispose();
      firstStorage.close();
      secondStorage.close();
    }
  });

  test("fails closed for channel, tenant and presence impersonation", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    const contexts = {
      alice: context(tenant, "alice"),
      mallory: context(otherTenant, "mallory"),
    };
    const fixture = createFixture(storage, contexts);
    const forbidden = createSocket();
    const isolated = createSocket();
    const impersonating = createSocket();

    try {
      fixture.gateway.open("connection-forbidden", forbidden);
      await fixture.gateway.receive(
        "connection-forbidden",
        joinMessage("alice", false, "private-room"),
      );
      expect(forbidden.closed).toEqual({ code: 1008, reason: "channel_forbidden" });

      fixture.gateway.open("connection-isolated1", isolated);
      await fixture.gateway.receive("connection-isolated1", joinMessage("mallory", false));
      expect(isolated.closed).toEqual({ code: 1008, reason: "channel_forbidden" });

      fixture.gateway.open("connection-imperson1", impersonating);
      await fixture.gateway.receive(
        "connection-imperson1",
        joinMessage("alice", false, "room", "bob"),
      );
      expect(impersonating.closed).toEqual({ code: 1008, reason: "presence_impersonation" });
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("enforces independent channel read and write policies", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    const contexts = {
      alice: context(tenant, "alice"),
      reader: context(tenant, "reader"),
      writer: context(tenant, "writer"),
    };
    const fixture = createFixture(storage, contexts);
    const alice = createSocket();
    const reader = createSocket();
    const writer = createSocket();

    try {
      fixture.gateway.open("connection-policy-01", alice);
      fixture.gateway.open("connection-policy-02", reader);
      fixture.gateway.open("connection-policy-03", writer);
      await fixture.gateway.receive("connection-policy-01", joinMessage("alice", true));
      await fixture.gateway.receive("connection-policy-02", joinMessage("reader", true));
      await fixture.gateway.receive("connection-policy-03", joinMessage("writer", true));
      expect(eventPayloads(writer, "presence_state")).toHaveLength(0);

      await fixture.gateway.receive(
        "connection-policy-02",
        broadcastMessage("2", "denied", { value: 1 }),
      );
      await fixture.gateway.receive(
        "connection-policy-02",
        presenceMessage("3", "track", { status: "denied" }),
      );
      expect(replyFor(reader, "2")).toEqual({
        status: "error",
        response: { reason: "channel_forbidden" },
      });
      expect(replyFor(reader, "3")).toEqual({
        status: "error",
        response: { reason: "channel_forbidden" },
      });

      await fixture.gateway.receive(
        "connection-policy-03",
        broadcastMessage("2", "allowed", { value: 2 }),
      );
      await fixture.gateway.receive(
        "connection-policy-03",
        presenceMessage("3", "track", { status: "online" }),
      );
      expect(eventPayloads(alice, "broadcast").at(-1)).toEqual({
        type: "broadcast",
        event: "allowed",
        payload: { value: 2 },
      });
      expect(readPresenceMetas(eventPayloads(alice, "presence_diff").at(-1))).toEqual([
        expect.objectContaining({ actor_id: "writer", status: "online" }),
      ]);
      expect(eventPayloads(writer, "broadcast")).toHaveLength(0);
      expect(eventPayloads(writer, "presence_diff")).toHaveLength(0);
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });

  test("keeps reconnected presence and removes the stale owner at the deterministic lease deadline", async () => {
    let clock = 1_000;
    const coordinator = createInMemoryRealtimeChannelCoordinator();
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    const contexts = { alice: context(tenant, "alice") };
    const fixture = createFixture(storage, contexts, {
      coordinator,
      now: () => clock,
      limits: { presenceLeaseMs: 100, pollIntervalMs: 10_000 },
    });
    const first = createSocket();
    const reconnected = createSocket();

    try {
      fixture.gateway.open("connection-stale-001", first);
      await fixture.gateway.receive("connection-stale-001", joinMessage("alice", true));
      await fixture.gateway.receive(
        "connection-stale-001",
        presenceMessage("2", "track", { connection: "old" }),
      );
      fixture.gateway.close("connection-stale-001");

      clock = 1_050;
      fixture.gateway.open("connection-fresh-001", reconnected);
      await fixture.gateway.receive("connection-fresh-001", joinMessage("alice", true));
      await fixture.gateway.receive(
        "connection-fresh-001",
        presenceMessage("2", "track", { connection: "new" }),
      );
      expect(readPresenceMetas(eventPayloads(reconnected, "presence_diff").at(-1))).toHaveLength(1);

      clock = 1_100;
      await fixture.gateway.receive("connection-fresh-001", [
        null,
        "3",
        "phoenix",
        "heartbeat",
        {},
      ]);
      clock = 1_101;
      await fixture.gateway.tick();

      const leave = eventPayloads(reconnected, "presence_diff").find((payload) => {
        const leaves = readPresenceMetas(payload, "leaves");
        return leaves.some((meta) => meta.connection === "old");
      });
      expect(leave).toBeDefined();
      expect(readPresenceMetas(leave, "leaves")).toEqual([
        expect.objectContaining({ actor_id: "alice", connection: "old" }),
      ]);
      expect(reconnected.closed).toBeNull();
    } finally {
      fixture.gateway.dispose();
      coordinator.dispose();
      storage.close();
    }
  });

  test("enforces payload, message-rate and presence-entry quotas", async () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    const contexts = {
      alice: context(tenant, "alice"),
      bob: context(tenant, "bob"),
    };
    const fixture = createFixture(storage, contexts, {
      limits: {
        maxBroadcastPayloadBytes: 8,
        maxBroadcastMessagesPerWindow: 1,
        maxPresenceEntriesPerChannel: 1,
      },
    });
    const alice = createSocket();
    const bob = createSocket();
    const oversized = createSocket();

    try {
      fixture.gateway.open("connection-abuse-001", alice);
      fixture.gateway.open("connection-abuse-002", bob);
      fixture.gateway.open("connection-abuse-003", oversized);
      await fixture.gateway.receive("connection-abuse-001", joinMessage("alice", false));
      await fixture.gateway.receive("connection-abuse-002", joinMessage("bob", false));
      await fixture.gateway.receive("connection-abuse-003", joinMessage("alice", false));

      await fixture.gateway.receive("connection-abuse-001", broadcastMessage("2", "one", { a: 1 }));
      await fixture.gateway.receive("connection-abuse-001", broadcastMessage("3", "two", { a: 2 }));
      expect(replyFor(alice, "3")).toEqual({
        status: "error",
        response: { reason: "rate_limit" },
      });

      await fixture.gateway.receive(
        "connection-abuse-003",
        broadcastMessage("2", "large", { content: "too-large" }),
      );
      expect(oversized.closed).toEqual({ code: 1008, reason: "invalid_broadcast" });

      await fixture.gateway.receive(
        "connection-abuse-001",
        presenceMessage("4", "track", { status: "online" }),
      );
      await fixture.gateway.receive(
        "connection-abuse-001",
        presenceMessage("5", "track", { status: "away" }),
      );
      expect(replyFor(alice, "5")).toEqual({ status: "ok", response: {} });
      await fixture.gateway.receive(
        "connection-abuse-002",
        presenceMessage("2", "track", { status: "online" }),
      );
      expect(replyFor(bob, "2")).toEqual({
        status: "error",
        response: { reason: "presence_quota" },
      });
    } finally {
      fixture.gateway.dispose();
      storage.close();
    }
  });
});

function createFixture(
  storage: StorageAdapter,
  contexts: Readonly<Record<string, TenantContext>>,
  options: Readonly<{
    coordinator?: ReturnType<typeof createInMemoryRealtimeChannelCoordinator>;
    now?: () => number;
    limits?: Partial<RealtimeSubscriptionLimits>;
  }> = {},
) {
  const gateway = createRealtimeSubscriptionGateway({
    authenticate(token) {
      const actor = token.endsWith("-realtime-token")
        ? token.slice(0, -"-realtime-token".length)
        : token;
      const selected = contexts[actor];
      if (selected === undefined) {
        throw new Error("invalid token");
      }
      return { context: selected, expiresAt: 4_000_000_000 };
    },
    resolveSource(selectedContext) {
      return createSource(storage, selectedContext.tenant);
    },
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
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
    subscribableTables: [],
    authorizeChannel(contextValue, channel) {
      if (channel !== "room" || sourceTenant.projectId !== tenant.projectId) {
        return null;
      }
      if (contextValue.actor.id === "reader") {
        return {
          broadcast: { read: true, write: false },
          presence: { read: true, write: false },
        };
      }
      if (contextValue.actor.id === "writer") {
        return {
          broadcast: { read: false, write: true },
          presence: { read: false, write: true },
        };
      }
      if (!["alice", "bob"].includes(contextValue.actor.id)) {
        return null;
      }
      return {
        broadcast: { read: true, write: true },
        presence: { read: true, write: true },
      };
    },
    authorize: () => null,
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

function context(selectedTenant: typeof tenant, actorId: string): TenantContext {
  return createTenantContext({
    tenant: selectedTenant,
    actor: { kind: "user", id: actorId },
    capabilities: [],
    correlationId: "018e6c28-0000-7000-8000-000000000001",
  });
}

function joinMessage(token: string, presenceEnabled: boolean, channel = "room", presenceKey = "") {
  return [
    null,
    "1",
    `realtime:${channel}`,
    "phx_join",
    {
      access_token: `${token}-realtime-token`,
      config: {
        broadcast: { ack: true, self: false },
        presence: { enabled: presenceEnabled, key: presenceKey },
      },
    },
  ];
}

function broadcastMessage(ref: string, event: string, payload: Record<string, unknown>) {
  return ["1", ref, "realtime:room", "broadcast", { type: "broadcast", event, payload }];
}

function presenceMessage(ref: string, event: string, payload?: Record<string, unknown>) {
  return [
    "1",
    ref,
    "realtime:room",
    "presence",
    { type: "presence", event, ...(payload === undefined ? {} : { payload }) },
  ];
}

type DecodedMessage = [string | null, string | null, string, string, Record<string, unknown>];

function decoded(socket: { messages: string[] }): DecodedMessage[] {
  return socket.messages.map((message) => JSON.parse(message) as DecodedMessage);
}

function eventPayloads(socket: { messages: string[] }, event: string): Record<string, unknown>[] {
  return decoded(socket)
    .filter((message) => message[3] === event)
    .map((message) => message[4]);
}

function replyFor(
  socket: { messages: string[] },
  ref: string,
): Record<string, unknown> | undefined {
  return decoded(socket).find((message) => message[1] === ref && message[3] === "phx_reply")?.[4];
}

function readPresenceMetas(
  payload: Record<string, unknown> | undefined,
  side: "joins" | "leaves" = "joins",
): Record<string, unknown>[] {
  const selected = payload?.[side];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    return [];
  }
  return Object.values(selected).flatMap((entry) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("metas" in entry)
    ) {
      return [];
    }
    return Array.isArray(entry.metas) ? (entry.metas as Record<string, unknown>[]) : [];
  });
}
