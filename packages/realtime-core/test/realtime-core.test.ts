import { describe, expect, test } from "bun:test";
import { parseTenantIdentity } from "@mekka/protocol";
import { openStorageAdapter, type StorageAdapter, type StorageExecutor } from "@mekka/storage-core";
import {
  appendChangeEvents,
  ChangefeedError,
  pruneChangefeed,
  readChangefeed,
  readChangefeedForDelivery,
} from "../src/index";

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
  generation: 2,
});

describe("SQLite realtime changefeed", () => {
  test("commits journal entries with the write and emits nothing on rollback", () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });
    storage.execute({ sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)" });

    try {
      storage.transaction((transaction) => {
        transaction.execute({
          sql: "INSERT INTO notes (id, body) VALUES (?, ?)",
          parameters: [1, "committed"],
        });
        append(transaction, tenant, "transaction_commit_01", 10, [
          change("event_commit_01", "INSERT", null, { id: 1, body: "committed" }),
        ]);
      });

      expect(() =>
        storage.transaction((transaction) => {
          transaction.execute({
            sql: "INSERT INTO notes (id, body) VALUES (?, ?)",
            parameters: [2, "rolled back"],
          });
          append(transaction, tenant, "transaction_rollback_01", 11, [
            change("event_rollback_01", "INSERT", null, { id: 2, body: "rolled back" }),
          ]);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");

      expect(storage.execute({ sql: "SELECT id FROM notes ORDER BY id" }).rows).toEqual([
        { id: 1 },
      ]);
      expect(readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 }).events).toEqual([
        expect.objectContaining({ eventId: "event_commit_01", operation: "INSERT" }),
      ]);
    } finally {
      storage.close();
    }
  });

  test("replays unchanged events for retry, preserves transaction order and supports deduplication", () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });

    try {
      storage.transaction((transaction) => {
        append(transaction, tenant, "transaction_order_01", 20, [
          change("event_order_01", "INSERT", null, { id: 1 }),
          change("event_order_02", "UPDATE", { id: 1 }, { id: 1, body: "updated" }),
        ]);
      });

      const first = readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 });
      const retry = readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 });
      expect(retry).toEqual(first);
      expect(first.events.map((event) => event.eventId)).toEqual([
        "event_order_01",
        "event_order_02",
      ]);
      expect(first.events.map((event) => event.transaction.sequence)).toEqual([1, 2]);
      expect(new Set(first.events.map((event) => event.eventId)).size).toBe(2);
      expect(
        readChangefeed(storage, { tenant, afterCursor: first.nextCursor, limit: 10 }).events,
      ).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("partitions events and retention floors by the full tenant tuple", () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });

    try {
      storage.transaction((transaction) => {
        append(transaction, tenant, "transaction_tenant_01", 30, [
          change("event_tenant_01", "INSERT", null, { id: 1 }),
        ]);
        append(transaction, otherTenant, "transaction_tenant_02", 31, [
          change("event_tenant_02", "INSERT", null, { id: 2 }),
        ]);
      });

      const own = readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 });
      const other = readChangefeed(storage, { tenant: otherTenant, afterCursor: 0, limit: 10 });
      expect(own.events.map((event) => event.eventId)).toEqual(["event_tenant_01"]);
      expect(other.events.map((event) => event.eventId)).toEqual(["event_tenant_02"]);

      pruneChangefeed(storage, tenant, own.nextCursor);
      expect(() => readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 })).toThrow(
        new ChangefeedError(
          "CHANGEFEED_RESYNC_REQUIRED",
          "The requested cursor is older than retained changefeed history; a full resync is required.",
        ),
      );
      expect(
        readChangefeed(storage, { tenant: otherTenant, afterCursor: 0, limit: 10 }).events,
      ).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  test("rolls retention deletion back when advancing the floor fails", () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });

    try {
      storage.transaction((transaction) => {
        append(transaction, tenant, "transaction_retention_01", 40, [
          change("event_retention_01", "INSERT", null, { id: 1 }),
        ]);
      });
      const cursor = readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 }).nextCursor;
      const failingStorage: StorageAdapter = {
        execute: storage.execute,
        createCheckpoint: storage.createCheckpoint,
        close: storage.close,
        transaction<T>(callback: (transaction: StorageExecutor) => T): T {
          return storage.transaction((transaction) =>
            callback({
              execute(statement) {
                if (statement.sql.startsWith("UPDATE _mekka_realtime_state")) {
                  throw new Error("retention state unavailable");
                }
                return transaction.execute(statement);
              },
            }),
          );
        },
      };

      expect(() => pruneChangefeed(failingStorage, tenant, cursor)).toThrow(
        "retention state unavailable",
      );
      expect(readChangefeed(storage, { tenant, afterCursor: 0, limit: 10 }).events).toHaveLength(1);
    } finally {
      storage.close();
    }
  });

  test("requires resync for legacy events without a policy snapshot", () => {
    const storage = openStorageAdapter({ databasePath: ":memory:" });

    try {
      readChangefeed(storage, { tenant, afterCursor: 0, limit: 1 });
      storage.execute({
        sql: "INSERT INTO _mekka_realtime_events (event_id, organization_id, project_id, environment_id, branch_id, generation, transaction_id, transaction_sequence, occurred_at, operation, table_name, old_record, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        parameters: [
          "event_legacy_01",
          tenant.organizationId,
          tenant.projectId,
          tenant.environmentId,
          tenant.branchId,
          tenant.generation,
          "transaction_legacy_01",
          1,
          50,
          "INSERT",
          "notes",
          null,
          JSON.stringify({ id: 1 }),
        ],
      });
      storage.execute({
        sql: "INSERT INTO _mekka_realtime_state (organization_id, project_id, environment_id, branch_id, generation, retained_after_cursor, last_cursor) VALUES (?, ?, ?, ?, ?, 0, 1)",
        parameters: [
          tenant.organizationId,
          tenant.projectId,
          tenant.environmentId,
          tenant.branchId,
          tenant.generation,
        ],
      });

      expect(() =>
        readChangefeedForDelivery(storage, { tenant, afterCursor: 0, limit: 1 }),
      ).toThrow(
        new ChangefeedError(
          "CHANGEFEED_RESYNC_REQUIRED",
          "The requested cursor contains events from before policy snapshots were available; a full resync is required.",
        ),
      );
    } finally {
      storage.close();
    }
  });
});

function append(
  transaction: Parameters<typeof appendChangeEvents>[0],
  selectedTenant: typeof tenant,
  transactionId: string,
  occurredAt: number,
  changes: Parameters<typeof appendChangeEvents>[1]["changes"],
): void {
  appendChangeEvents(transaction, { tenant: selectedTenant, transactionId, occurredAt, changes });
}

function change(
  eventId: string,
  operation: "INSERT" | "UPDATE" | "DELETE",
  oldRecord: Readonly<Record<string, string | number | null>> | null,
  record: Readonly<Record<string, string | number | null>> | null,
) {
  return Object.freeze({
    eventId,
    operation,
    table: "notes",
    oldRecord,
    record,
    policyOldRecord: oldRecord,
    policyRecord: record,
  });
}
