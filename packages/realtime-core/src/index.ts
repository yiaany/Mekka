import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";
import type { StorageAdapter, StorageExecutor, StorageValue } from "@mekka/storage-core";

export const changefeedFormatVersion = 1;

export type ChangeOperation = "INSERT" | "UPDATE" | "DELETE";
export type ChangeRecordValue = string | number | null;
export type ChangeRecord = Readonly<Record<string, ChangeRecordValue>>;

export type ChangefeedEvent = Readonly<{
  formatVersion: typeof changefeedFormatVersion;
  cursor: number;
  eventId: string;
  tenant: TenantIdentity;
  transaction: Readonly<{
    id: string;
    sequence: number;
    occurredAt: number;
  }>;
  operation: ChangeOperation;
  table: string;
  oldRecord: ChangeRecord | null;
  record: ChangeRecord | null;
}>;

export type PendingChange = Readonly<{
  eventId: string;
  operation: ChangeOperation;
  table: string;
  oldRecord: ChangeRecord | null;
  record: ChangeRecord | null;
}>;

export type AppendChangefeedInput = Readonly<{
  tenant: TenantIdentity;
  transactionId: string;
  occurredAt: number;
  changes: readonly PendingChange[];
}>;

export type ReadChangefeedInput = Readonly<{
  tenant: TenantIdentity;
  afterCursor: number;
  limit: number;
}>;

export type ChangefeedBatch = Readonly<{
  events: readonly ChangefeedEvent[];
  nextCursor: number;
}>;

export type ChangefeedErrorCode =
  | "CHANGEFEED_VALIDATION"
  | "CHANGEFEED_RESYNC_REQUIRED"
  | "CHANGEFEED_INFRASTRUCTURE";

export class ChangefeedError extends Error {
  readonly code: ChangefeedErrorCode;

  constructor(code: ChangefeedErrorCode, message: string) {
    super(message);
    this.name = "ChangefeedError";
    this.code = code;
  }
}

const safeEventIdPattern = /^[A-Za-z0-9_-]{8,128}$/;
const safeTablePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function initializeChangefeed(storage: StorageExecutor): void {
  storage.execute({
    sql: "CREATE TABLE IF NOT EXISTS _mekka_realtime_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, branch_id TEXT NOT NULL, generation INTEGER NOT NULL, transaction_id TEXT NOT NULL, transaction_sequence INTEGER NOT NULL, occurred_at INTEGER NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')), table_name TEXT NOT NULL, old_record TEXT, record TEXT, UNIQUE (organization_id, project_id, environment_id, branch_id, generation, transaction_id, transaction_sequence))",
  });
  storage.execute({
    sql: "CREATE INDEX IF NOT EXISTS _mekka_realtime_events_tenant_cursor ON _mekka_realtime_events (organization_id, project_id, environment_id, branch_id, generation, cursor)",
  });
  storage.execute({
    sql: "CREATE TABLE IF NOT EXISTS _mekka_realtime_state (organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, branch_id TEXT NOT NULL, generation INTEGER NOT NULL, retained_after_cursor INTEGER NOT NULL DEFAULT 0, last_cursor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation))",
  });
}

export function appendChangeEvents(
  transaction: StorageExecutor,
  input: AppendChangefeedInput,
): readonly ChangefeedEvent[] {
  const tenant = parseTenantIdentity(input.tenant);
  validateCursor(input.occurredAt, "Change occurrence time");
  if (!safeEventIdPattern.test(input.transactionId) || input.changes.length === 0) {
    throw validation("Changefeed transaction metadata is invalid.");
  }

  initializeChangefeed(transaction);
  const events: ChangefeedEvent[] = [];
  for (const [index, change] of input.changes.entries()) {
    validatePendingChange(change);
    const sequence = index + 1;
    const result = transaction.execute({
      sql: "INSERT INTO _mekka_realtime_events (event_id, organization_id, project_id, environment_id, branch_id, generation, transaction_id, transaction_sequence, occurred_at, operation, table_name, old_record, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      parameters: [
        change.eventId,
        tenant.organizationId,
        tenant.projectId,
        tenant.environmentId,
        tenant.branchId,
        tenant.generation,
        input.transactionId,
        sequence,
        input.occurredAt,
        change.operation,
        change.table,
        serializeRecord(change.oldRecord),
        serializeRecord(change.record),
      ],
    });
    const cursor = readCursor(result.lastInsertRowid, "Inserted change cursor");
    events.push(freezeEvent(cursor, tenant, input, sequence, change));
  }

  const lastCursor = events.at(-1)?.cursor;
  if (lastCursor === undefined) {
    throw infrastructure("Changefeed transaction did not produce a cursor.");
  }
  transaction.execute({
    sql: "INSERT INTO _mekka_realtime_state (organization_id, project_id, environment_id, branch_id, generation, retained_after_cursor, last_cursor) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT (organization_id, project_id, environment_id, branch_id, generation) DO UPDATE SET last_cursor = excluded.last_cursor",
    parameters: tenantParameters(tenant, [lastCursor]),
  });
  return Object.freeze(events);
}

export function readChangefeed(
  storage: StorageExecutor,
  input: ReadChangefeedInput,
): ChangefeedBatch {
  const tenant = parseTenantIdentity(input.tenant);
  validateCursor(input.afterCursor, "Changefeed cursor");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
    throw validation("Changefeed limit must be between 1 and 1000.");
  }

  initializeChangefeed(storage);
  const state = readState(storage, tenant);
  if (input.afterCursor < state.retainedAfterCursor) {
    throw new ChangefeedError(
      "CHANGEFEED_RESYNC_REQUIRED",
      "The requested cursor is older than retained changefeed history; a full resync is required.",
    );
  }
  if (input.afterCursor > state.lastCursor) {
    throw validation("Changefeed cursor is ahead of the tenant journal.");
  }

  const rows = storage.execute<ChangefeedRow>({
    sql: "SELECT cursor, event_id AS eventId, transaction_id AS transactionId, transaction_sequence AS transactionSequence, occurred_at AS occurredAt, operation, table_name AS tableName, old_record AS oldRecord, record FROM _mekka_realtime_events WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND branch_id = ? AND generation = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?",
    parameters: tenantParameters(tenant, [input.afterCursor, input.limit]),
  }).rows;
  const events = rows.map((row) => parseEventRow(row, tenant));
  return Object.freeze({
    events: Object.freeze(events),
    nextCursor: events.at(-1)?.cursor ?? input.afterCursor,
  });
}

export function pruneChangefeed(
  storage: StorageAdapter,
  tenantInput: TenantIdentity,
  throughCursor: number,
): void {
  const tenant = parseTenantIdentity(tenantInput);
  validateCursor(throughCursor, "Retention cursor");
  storage.transaction((transaction) => {
    initializeChangefeed(transaction);
    const state = readState(transaction, tenant);
    if (throughCursor < state.retainedAfterCursor || throughCursor > state.lastCursor) {
      throw validation("Retention cursor must be within the tenant journal.");
    }

    transaction.execute({
      sql: "DELETE FROM _mekka_realtime_events WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND branch_id = ? AND generation = ? AND cursor <= ?",
      parameters: tenantParameters(tenant, [throughCursor]),
    });
    transaction.execute({
      sql: "UPDATE _mekka_realtime_state SET retained_after_cursor = ? WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND branch_id = ? AND generation = ?",
      parameters: [throughCursor, ...tenantParameters(tenant)],
    });
  });
}

type ChangefeedRow = Readonly<{
  cursor: StorageValue;
  eventId: StorageValue;
  transactionId: StorageValue;
  transactionSequence: StorageValue;
  occurredAt: StorageValue;
  operation: StorageValue;
  tableName: StorageValue;
  oldRecord: StorageValue;
  record: StorageValue;
}>;

function readState(
  storage: StorageExecutor,
  tenant: TenantIdentity,
): Readonly<{ retainedAfterCursor: number; lastCursor: number }> {
  const row = storage.execute<{
    retainedAfterCursor: StorageValue;
    lastCursor: StorageValue;
  }>({
    sql: "SELECT retained_after_cursor AS retainedAfterCursor, last_cursor AS lastCursor FROM _mekka_realtime_state WHERE organization_id = ? AND project_id = ? AND environment_id = ? AND branch_id = ? AND generation = ?",
    parameters: tenantParameters(tenant),
  }).rows[0];
  if (row === undefined) {
    return Object.freeze({ retainedAfterCursor: 0, lastCursor: 0 });
  }
  return Object.freeze({
    retainedAfterCursor: readCursor(row.retainedAfterCursor, "Retained change cursor"),
    lastCursor: readCursor(row.lastCursor, "Last change cursor"),
  });
}

function parseEventRow(row: ChangefeedRow, tenant: TenantIdentity): ChangefeedEvent {
  const eventId = readString(row.eventId, "Event identifier");
  const transactionId = readString(row.transactionId, "Transaction identifier");
  const operation = row.operation;
  if (operation !== "INSERT" && operation !== "UPDATE" && operation !== "DELETE") {
    throw infrastructure("Changefeed operation is invalid.");
  }
  return Object.freeze({
    formatVersion: changefeedFormatVersion,
    cursor: readCursor(row.cursor, "Change cursor"),
    eventId,
    tenant,
    transaction: Object.freeze({
      id: transactionId,
      sequence: readPositiveInteger(row.transactionSequence, "Transaction sequence"),
      occurredAt: readCursor(row.occurredAt, "Change occurrence time"),
    }),
    operation,
    table: readString(row.tableName, "Table name"),
    oldRecord: parseRecord(row.oldRecord),
    record: parseRecord(row.record),
  });
}

function validatePendingChange(change: PendingChange): void {
  if (!safeEventIdPattern.test(change.eventId) || !safeTablePattern.test(change.table)) {
    throw validation("Changefeed event identifier or table is invalid.");
  }
  if (
    (change.operation === "INSERT" && (change.oldRecord !== null || change.record === null)) ||
    (change.operation === "UPDATE" && (change.oldRecord === null || change.record === null)) ||
    (change.operation === "DELETE" && (change.oldRecord === null || change.record !== null))
  ) {
    throw validation("Changefeed record shape does not match its operation.");
  }
  validateRecord(change.oldRecord);
  validateRecord(change.record);
}

function validateRecord(record: ChangeRecord | null): void {
  if (record === null) {
    return;
  }
  for (const [field, value] of Object.entries(record)) {
    if (
      !safeTablePattern.test(field) ||
      (typeof value !== "string" && typeof value !== "number" && value !== null) ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw validation("Changefeed record contains an invalid field or value.");
    }
  }
}

function serializeRecord(record: ChangeRecord | null): string | null {
  return record === null ? null : JSON.stringify(record);
}

function parseRecord(value: StorageValue): ChangeRecord | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw infrastructure("Changefeed record payload is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid record.");
    }
    const record = parsed as Record<string, unknown>;
    validateRecord(record as ChangeRecord);
    return Object.freeze({ ...(record as Record<string, ChangeRecordValue>) });
  } catch (error) {
    if (error instanceof ChangefeedError) {
      throw infrastructure("Changefeed record payload is invalid.");
    }
    throw infrastructure("Changefeed record payload is invalid.");
  }
}

function tenantParameters(
  tenant: TenantIdentity,
  suffix: readonly StorageValue[] = [],
): readonly StorageValue[] {
  return [
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
    ...suffix,
  ];
}

function freezeEvent(
  cursor: number,
  tenant: TenantIdentity,
  input: AppendChangefeedInput,
  sequence: number,
  change: PendingChange,
): ChangefeedEvent {
  return Object.freeze({
    formatVersion: changefeedFormatVersion,
    cursor,
    eventId: change.eventId,
    tenant,
    transaction: Object.freeze({ id: input.transactionId, sequence, occurredAt: input.occurredAt }),
    operation: change.operation,
    table: change.table,
    oldRecord: change.oldRecord,
    record: change.record,
  });
}

function readString(value: StorageValue, field: string): string {
  if (typeof value !== "string") {
    throw infrastructure(`${field} is invalid.`);
  }
  return value;
}

function readCursor(value: StorageValue, field: string): number {
  if (typeof value === "bigint") {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number >= 0) {
      return number;
    }
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw infrastructure(`${field} is invalid.`);
}

function readPositiveInteger(value: StorageValue, field: string): number {
  const number = readCursor(value, field);
  if (number < 1) {
    throw infrastructure(`${field} is invalid.`);
  }
  return number;
}

function validateCursor(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation(`${field} must be a non-negative safe integer.`);
  }
}

function validation(message: string): ChangefeedError {
  return new ChangefeedError("CHANGEFEED_VALIDATION", message);
}

function infrastructure(message: string): ChangefeedError {
  return new ChangefeedError("CHANGEFEED_INFRASTRUCTURE", message);
}
