import { createHash } from "node:crypto";
import { buildSchemaManifest } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter, type StorageExecutor } from "@mekka/storage-core";

export const migrationArtifactFormatVersion = 1;
export const backupFormatVersion = 1;

export type MigrationArtifact = Readonly<{
  formatVersion: typeof migrationArtifactFormatVersion;
  id: string;
  actorId: string;
  idempotencyKey: string;
  expectedSchemaHash: string;
  sql: string;
  hash: string;
}>;

export type CreateMigrationArtifactInput = Readonly<{
  id: string;
  actorId: string;
  idempotencyKey: string;
  expectedSchemaHash: string;
  sql: string;
}>;

export type MigrationApplyResult = Readonly<{
  status: "applied" | "replayed";
  migrationHash: string;
  schemaHash: string;
}>;

export type ApplyMigrationOptions = Readonly<{
  checkpoint?: BackupArtifact;
}>;

export type BackupArtifact = Readonly<{
  formatVersion: typeof backupFormatVersion;
  id: string;
  sourceSchemaHash: string;
  schemaFingerprint: string;
  checkpointPath: string;
}>;

export type CheckpointOptions = Readonly<{
  id: string;
  checkpointPath: string;
  checkpointDirectory: string;
}>;

export type RestoreOptions = Readonly<{
  destinationPath: string;
  destinationDirectory: string;
  sourceDirectory?: string;
}>;

export type MigrationErrorCode =
  | "MIGRATION_VALIDATION"
  | "MIGRATION_CONFLICT"
  | "MIGRATION_FORBIDDEN"
  | "MIGRATION_INFRASTRUCTURE";

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

const safeIdPattern = /^[A-Za-z0-9_-]{3,128}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function createMigrationArtifact(input: CreateMigrationArtifactInput): MigrationArtifact {
  validateArtifactInput(input);
  const hash = hashArtifact(input);
  return Object.freeze({ ...input, formatVersion: migrationArtifactFormatVersion, hash });
}

export function applyMigration(
  storage: StorageAdapter,
  artifact: MigrationArtifact,
  options: ApplyMigrationOptions = {},
): MigrationApplyResult {
  validateArtifact(artifact);

  return storage.transaction((transaction) => {
    const currentSchemaHash = buildSchemaManifest(transaction).hash;
    initializeLedger(transaction);
    const existing = readLedger(transaction, artifact.id);
    if (existing !== null) {
      if (existing.hash !== artifact.hash) {
        throw new MigrationError(
          "MIGRATION_CONFLICT",
          "Migration identifier was reused with a different artifact.",
        );
      }
      if (existing.state === "applied") {
        return Object.freeze({
          status: "replayed" as const,
          migrationHash: artifact.hash,
          schemaHash: existing.schemaHash,
        });
      }
      throw new MigrationError(
        "MIGRATION_INFRASTRUCTURE",
        "Migration ledger is in an unexpected state.",
      );
    }
    if (currentSchemaHash !== artifact.expectedSchemaHash) {
      throw new MigrationError(
        "MIGRATION_CONFLICT",
        "Migration expected schema does not match target.",
      );
    }
    if (
      isDestructiveDdl(artifact.sql) &&
      options.checkpoint?.sourceSchemaHash !== currentSchemaHash
    ) {
      throw new MigrationError(
        "MIGRATION_FORBIDDEN",
        "Destructive migration requires a checkpoint for the current schema.",
      );
    }

    transaction.execute({
      sql: "INSERT INTO _mekka_migrations (id, hash, actor_id, idempotency_key, expected_schema_hash, state, applied_schema_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      parameters: [
        artifact.id,
        artifact.hash,
        artifact.actorId,
        artifact.idempotencyKey,
        artifact.expectedSchemaHash,
        "applying",
        null,
      ],
    });
    transaction.execute({ sql: artifact.sql });
    const schemaHash = buildSchemaManifest(transaction).hash;
    transaction.execute({
      sql: "UPDATE _mekka_migrations SET state = ?, applied_schema_hash = ? WHERE id = ?",
      parameters: ["applied", schemaHash, artifact.id],
    });
    return Object.freeze({ status: "applied" as const, migrationHash: artifact.hash, schemaHash });
  });
}

export function createCheckpoint(
  storage: StorageAdapter,
  options: CheckpointOptions,
): BackupArtifact {
  if (!safeIdPattern.test(options.id)) {
    throw new MigrationError("MIGRATION_VALIDATION", "Checkpoint identifier is invalid.");
  }
  const sourceSchemaHash = buildSchemaManifest(storage).hash;
  const schemaFingerprint = fingerprintSchema(storage);
  storage.createCheckpoint({
    destinationPath: options.checkpointPath,
    destinationDirectory: options.checkpointDirectory,
  });
  return Object.freeze({
    formatVersion: backupFormatVersion,
    id: options.id,
    sourceSchemaHash,
    schemaFingerprint,
    checkpointPath: options.checkpointPath,
  });
}

export function restoreCheckpoint(backup: BackupArtifact, options: RestoreOptions): StorageAdapter {
  validateBackup(backup);
  const source = openStorageAdapter({
    databasePath: backup.checkpointPath,
    databaseDirectory: options.sourceDirectory ?? options.destinationDirectory,
  });
  try {
    verifyIntegrity(source);
    if (fingerprintSchema(source) !== backup.schemaFingerprint) {
      throw new MigrationError(
        "MIGRATION_CONFLICT",
        "Checkpoint schema does not match backup metadata.",
      );
    }
    source.createCheckpoint({
      destinationPath: options.destinationPath,
      destinationDirectory: options.destinationDirectory,
    });
  } finally {
    source.close();
  }

  const restored = openStorageAdapter({
    databasePath: options.destinationPath,
    databaseDirectory: options.destinationDirectory,
  });
  try {
    verifyIntegrity(restored);
    if (fingerprintSchema(restored) !== backup.schemaFingerprint) {
      throw new MigrationError(
        "MIGRATION_INFRASTRUCTURE",
        "Restored checkpoint schema is invalid.",
      );
    }
    return restored;
  } catch (error) {
    restored.close();
    throw error;
  }
}

function initializeLedger(storage: StorageExecutor): void {
  storage.execute({
    sql: "CREATE TABLE IF NOT EXISTS _mekka_migrations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, expected_schema_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('applying', 'applied')), applied_schema_hash TEXT)",
  });
}

function readLedger(
  transaction: StorageExecutor,
  id: string,
): Readonly<{ hash: string; state: string; schemaHash: string }> | null {
  const row = transaction.execute<{
    hash: string;
    state: string;
    appliedSchemaHash: string | null;
  }>({
    sql: "SELECT hash, state, applied_schema_hash AS appliedSchemaHash FROM _mekka_migrations WHERE id = ?",
    parameters: [id],
  }).rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    typeof row.hash !== "string" ||
    typeof row.state !== "string" ||
    typeof row.appliedSchemaHash !== "string"
  ) {
    throw new MigrationError(
      "MIGRATION_INFRASTRUCTURE",
      "Migration ledger contains an invalid row.",
    );
  }
  return Object.freeze({ hash: row.hash, state: row.state, schemaHash: row.appliedSchemaHash });
}

function validateArtifactInput(input: CreateMigrationArtifactInput): void {
  if (
    !safeIdPattern.test(input.id) ||
    !safeIdPattern.test(input.actorId) ||
    !safeIdPattern.test(input.idempotencyKey)
  ) {
    throw new MigrationError("MIGRATION_VALIDATION", "Migration identifiers are invalid.");
  }
  if (!sha256Pattern.test(input.expectedSchemaHash)) {
    throw new MigrationError("MIGRATION_VALIDATION", "Migration expected schema hash is invalid.");
  }
  validateDdl(input.sql);
}

function validateArtifact(artifact: MigrationArtifact): void {
  if (
    artifact.formatVersion !== migrationArtifactFormatVersion ||
    hashArtifact(artifact) !== artifact.hash
  ) {
    throw new MigrationError(
      "MIGRATION_VALIDATION",
      "Migration artifact hash or format is invalid.",
    );
  }
  validateArtifactInput(artifact);
}

function validateBackup(backup: BackupArtifact): void {
  if (
    backup.formatVersion !== backupFormatVersion ||
    !safeIdPattern.test(backup.id) ||
    !sha256Pattern.test(backup.sourceSchemaHash) ||
    !sha256Pattern.test(backup.schemaFingerprint) ||
    backup.checkpointPath.length === 0
  ) {
    throw new MigrationError("MIGRATION_VALIDATION", "Backup artifact is invalid.");
  }
}

function validateDdl(sql: string): void {
  if (typeof sql !== "string" || sql.length === 0 || sql.length > 16_384 || sql.includes(";")) {
    throw new MigrationError(
      "MIGRATION_VALIDATION",
      "Migration must contain one bounded DDL statement.",
    );
  }
  const normalized = sql.trim().replaceAll(/\s+/g, " ");
  const allowed = [
    /^CREATE TABLE (?:IF NOT EXISTS )?"?[A-Za-z_][A-Za-z0-9_]*"? \(.+\)$/i,
    /^ALTER TABLE "?[A-Za-z_][A-Za-z0-9_]*"? ADD COLUMN "?[A-Za-z_][A-Za-z0-9_]*"? [A-Za-z][A-Za-z0-9_]*(?: .+)?$/i,
    /^ALTER TABLE "?[A-Za-z_][A-Za-z0-9_]*"? RENAME TO "?[A-Za-z_][A-Za-z0-9_]*"?$/i,
    /^ALTER TABLE "?[A-Za-z_][A-Za-z0-9_]*"? RENAME COLUMN "?[A-Za-z_][A-Za-z0-9_]*"? TO "?[A-Za-z_][A-Za-z0-9_]*"?$/i,
    /^CREATE (?:UNIQUE )?INDEX "?[A-Za-z_][A-Za-z0-9_]*"? ON "?[A-Za-z_][A-Za-z0-9_]*"? \(.+\)$/i,
    /^DROP TABLE "?[A-Za-z_][A-Za-z0-9_]*"?$/i,
    /^DROP INDEX "?[A-Za-z_][A-Za-z0-9_]*"?$/i,
  ];
  if (!allowed.some((pattern) => pattern.test(normalized))) {
    throw new MigrationError("MIGRATION_FORBIDDEN", "Migration DDL is not allowlisted.");
  }
  if (/\b(?:attach|detach|pragma|trigger|view|virtual|load_extension|vacuum)\b/i.test(normalized)) {
    throw new MigrationError("MIGRATION_FORBIDDEN", "Migration uses a dangerous schema construct.");
  }
}

function isDestructiveDdl(sql: string): boolean {
  return /^DROP (?:TABLE|INDEX)\b/i.test(sql.trim());
}

function verifyIntegrity(storage: StorageExecutor): void {
  const value = storage.execute<{ integrity: string }>({
    sql: "SELECT integrity_check AS integrity FROM pragma_integrity_check",
  }).rows[0]?.integrity;
  if (value !== "ok") {
    throw new MigrationError(
      "MIGRATION_INFRASTRUCTURE",
      "SQLite integrity check failed for checkpoint.",
    );
  }
}

function hashArtifact(input: Omit<MigrationArtifact, "formatVersion" | "hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: input.id,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        expectedSchemaHash: input.expectedSchemaHash,
        sql: input.sql,
      }),
    )
    .digest("hex");
}

function fingerprintSchema(storage: StorageExecutor): string {
  return createHash("sha256")
    .update(JSON.stringify(buildSchemaManifest(storage).tables))
    .digest("hex");
}
