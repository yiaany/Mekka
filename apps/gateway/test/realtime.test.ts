import { expect, test } from "bun:test";
import { type PolicyDocument, policyFormatVersion } from "@mekka/policy-engine";
import { createTenantContext, parseTenantIdentity, type TenantContext } from "@mekka/protocol";
import { appendChangeEvents } from "@mekka/realtime-core";
import { openStorageAdapter } from "@mekka/storage-core";
import { createRealtimeRoutes } from "../src/realtime";

const tenant = parseTenantIdentity({
  organizationId: "org-main",
  projectId: "project-main",
  environmentId: "environment-main",
  branchId: "branch-main",
  generation: 1,
});

const policies: PolicyDocument = {
  formatVersion: policyFormatVersion,
  tables: [
    {
      table: "notes",
      rules: [
        {
          name: "owner-read",
          action: "select",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["id", "body"], deny: ["private_note"] },
        },
      ],
    },
  ],
};

test("serves authenticated Phoenix WebSocket join, heartbeat, change, ack and leave", async () => {
  const storage = openStorageAdapter({ databasePath: ":memory:" });
  storage.execute({
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL, private_note TEXT)",
  });
  storage.transaction((transaction) => {
    appendChangeEvents(transaction, {
      tenant,
      transactionId: "transaction_websocket_01",
      occurredAt: 1_000_000,
      changes: [
        {
          eventId: "event_websocket_01",
          operation: "INSERT",
          table: "notes",
          oldRecord: null,
          record: { id: 1, body: "visible" },
          policyOldRecord: null,
          policyRecord: {
            id: 1,
            owner_id: "alice",
            body: "visible",
            private_note: "secret",
          },
        },
      ],
    });
  });
  const tenantContext = context("alice");
  const project = {
    tenant,
    storage,
    policies,
    realtimeChannels: [
      {
        channel: "notes",
        memberActorIds: ["alice"],
        broadcast: { read: true, write: true },
        presence: { read: true, write: true },
      },
    ],
  };
  const app = createRealtimeRoutes({
    authenticateRealtimeToken(token) {
      if (token !== "gateway-realtime-token") {
        throw new Error("invalid token");
      }
      return { context: tenantContext, expiresAt: 4_000_000_000 };
    },
    resolveRealtimeProject: () => project,
    realtimeLimits: { pollIntervalMs: 10 },
  });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const server = app.server;
  if (server === null) {
    throw new Error("Realtime test server did not start.");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/realtime/v1/websocket`);
  const messages: DecodedMessage[] = [];
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)) as DecodedMessage);
  });

  try {
    await waitForOpen(socket);
    socket.send(JSON.stringify([null, "h1", "phoenix", "heartbeat", {}]));
    await waitForMessage(messages, (message) => message[2] === "phoenix");

    socket.send(
      JSON.stringify([
        null,
        "1",
        "realtime:notes",
        "phx_join",
        {
          access_token: "gateway-realtime-token",
          cursor: 0,
          config: {
            broadcast: { ack: true, self: true },
            presence: { enabled: true, key: "" },
            postgres_changes: [{ event: "*", schema: "public", table: "notes" }],
          },
        },
      ]),
    );
    const joinReply = await waitForMessage(
      messages,
      (message) => message[2] === "realtime:notes" && message[3] === "phx_reply",
    );
    expect(joinReply[4].status).toBe("ok");
    const change = await waitForMessage(messages, (message) => message[3] === "postgres_changes");
    expect(change[4].data).toEqual(
      expect.objectContaining({
        event_id: "event_websocket_01",
        record: { id: 1, body: "visible" },
      }),
    );
    expect(JSON.stringify(change)).not.toContain("secret");

    await waitForMessage(messages, (message) => message[3] === "presence_state");
    socket.send(
      JSON.stringify([
        "1",
        "presence-1",
        "realtime:notes",
        "presence",
        { type: "presence", event: "track", payload: { status: "online" } },
      ]),
    );
    const presence = await waitForMessage(messages, (message) => message[3] === "presence_diff");
    expect(JSON.stringify(presence)).toContain('"actor_id":"alice"');
    socket.send(
      JSON.stringify([
        "1",
        "broadcast-1",
        "realtime:notes",
        "broadcast",
        { type: "broadcast", event: "cursor-pos", payload: { x: 10 } },
      ]),
    );
    const broadcast = await waitForMessage(messages, (message) => message[3] === "broadcast");
    expect(broadcast[4]).toEqual({
      type: "broadcast",
      event: "cursor-pos",
      payload: { x: 10 },
    });

    const cursor = readChangeCursor(change);
    socket.send(JSON.stringify(["1", "2", "realtime:notes", "mekka_ack", { cursor }]));
    await waitForMessage(messages, (message) => message[3] === "phx_reply" && message[1] === "2");
    socket.send(JSON.stringify(["1", "3", "realtime:notes", "phx_leave", {}]));
    const leaveReply = await waitForMessage(
      messages,
      (message) => message[3] === "phx_reply" && message[1] === "3",
    );
    expect(leaveReply[4].status).toBe("ok");
  } finally {
    socket.close();
    await app.stop(true);
    storage.close();
  }
});

type DecodedMessage = [string | null, string | null, string, string, Record<string, unknown>];

function context(actorId: string): TenantContext {
  return createTenantContext({
    tenant,
    actor: { kind: "user", id: actorId },
    capabilities: [],
    correlationId: "018e6c28-0000-7000-8000-000000000001",
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket open timed out.")), 2_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed to open."));
      },
      { once: true },
    );
  });
}

async function waitForMessage(
  messages: readonly DecodedMessage[],
  predicate: (message: DecodedMessage) => boolean,
): Promise<DecodedMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message !== undefined) {
      return message;
    }
    await Bun.sleep(5);
  }
  throw new Error("WebSocket message timed out.");
}

function readChangeCursor(message: DecodedMessage): number {
  const data = message[4].data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    !("cursor" in data) ||
    typeof data.cursor !== "number"
  ) {
    throw new Error("Expected change cursor.");
  }
  return data.cursor;
}
