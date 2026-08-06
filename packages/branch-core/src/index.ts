import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  type BackupArtifact,
  type MigrationArtifact,
  MigrationError,
  applyMigration,
  createCheckpoint,
  createMigrationArtifact,
  restoreCheckpoint,
} from "@mekka/migration-engine";
import {
  ProtocolError,
  createErrorEnvelope,
  hasCapability,
  parseBranchId,
  parseGeneration,
  parseTenantIdentity,
  serializeTenantIdentity,
  type TenantContext,
  type TenantIdentity,
} from "@mekka/protocol";
import { buildSchemaManifest } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";

export const branchCatalogFormatVersion = 1;

export type BranchState =
  | "active"
  | "migrating"
  | "promoting"
  | "promoted"
  | "deleting"
  | "deleting_active";

export type BranchRecord = Readonly<{
  formatVersion: typeof branchCatalogFormatVersion;
  tenant: TenantIdentity;
  parentTenant: TenantIdentity;
  state: BranchState;
  parentCheckpoint: BackupArtifact;
  parentSchemaHash: string;
  branchSchemaHash: string;
  databasePath: string;
  credentialId: string;
  createdAt: number;
  expiresAt: number;
  promotedAt: number | null;
}>;

export type BranchCredential = Readonly<{
  id: string;
  token: string;
  url: string;
  expiresAt: number;
  tenant: TenantIdentity;
}>;

export type BranchCredentialIssuer = Readonly<{
  issue(
    input: Readonly<{ tenant: TenantIdentity; credentialId: string; expiresAt: number }>,
  ): Promise<BranchCredential>;
  revoke(input: Readonly<{ tenant: TenantIdentity; credentialId: string }>): Promise<void>;
}>;

export type PreviewAuthStore = Readonly<{
  create(
    tenant: TenantIdentity,
    syntheticUsers: readonly Readonly<{ id: string; email: string; name: string }>[],
  ): Promise<void>;
  delete(tenant: TenantIdentity): Promise<void>;
}>;

export type BranchAuditEvent = Readonly<{
  action: "branch.create" | "branch.migrate" | "branch.promote" | "branch.delete";
  actorId: string;
  tenant: TenantIdentity;
  parentTenant: TenantIdentity;
  correlationId: string;
  migrationHash: string | null;
  restorePointId: string | null;
  occurredAt: number;
}>;

export type BranchAuditSink = Readonly<{
  record(event: BranchAuditEvent): void | Promise<void>;
}>;

export type ParentDatabase = Readonly<{
  tenant: TenantIdentity;
  storage: StorageAdapter;
  production: boolean;
  withMutationLock<T>(operation: () => T): T;
}>;

export type BranchServiceOptions = Readonly<{
  catalogPath: string;
  catalogDirectory: string;
  databaseDirectory: string;
  checkpointDirectory: string;
  resolveParent(tenant: TenantIdentity): ParentDatabase;
  credentials: BranchCredentialIssuer;
  auth: PreviewAuthStore;
  audit: BranchAuditSink;
  now?: () => number;
}>;

export type CreateBranchInput = Readonly<{
  tenant: TenantIdentity;
  parentTenant: TenantIdentity;
  ttlSeconds: number;
  idempotencyKey: string;
  syntheticUsers?: readonly Readonly<{ id: string; email: string; name: string }>[];
}>;

export type CreateBranchResult = Readonly<{
  branch: BranchRecord;
  credential: BranchCredential;
}>;

export type PromotionResult = Readonly<{
  status: "applied" | "replayed";
  branch: BranchRecord;
  migrationHash: string;
  schemaHash: string;
  restorePoint: BackupArtifact;
}>;

export type EngineCapabilityRecord = Readonly<{
  engine: "local-bun-sqlite" | "libsql" | "turso-database" | "turso-cloud";
  status: "implemented" | "verified_upstream" | "unsupported";
  snapshotPrimitive: string;
  branchPrimitive: string;
  credentials: string;
  notes: string;
}>;

export const engineCapabilities: readonly EngineCapabilityRecord[] = Object.freeze([
  Object.freeze({
    engine: "local-bun-sqlite",
    status: "implemented",
    snapshotPrimitive: "StorageAdapter VACUUM INTO",
    branchPrimitive: "independent verified SQLite snapshot",
    credentials: "external tenant-bound issuer",
    notes:
      "Promotion replays migration artifacts; database files are never swapped into production.",
  }),
  Object.freeze({
    engine: "libsql",
    status: "verified_upstream",
    snapshotPrimitive: "replication snapshots and SQLite online backup primitives",
    branchPrimitive: "no product branch lifecycle claimed by this adapter",
    credentials: "not implemented",
    notes: "Requires a remote adapter and conformance tests before use.",
  }),
  Object.freeze({
    engine: "turso-database",
    status: "unsupported",
    snapshotPrimitive: "engine backup support is not exposed by this package",
    branchPrimitive: "no managed database creation API in the in-process engine",
    credentials: "not implemented",
    notes: "Do not infer Turso Cloud capabilities from the in-process engine.",
  }),
  Object.freeze({
    engine: "turso-cloud",
    status: "verified_upstream",
    snapshotPrimitive: "platform database creation from an existing database",
    branchPrimitive: "managed database clone via official platform API",
    credentials: "separate database token via official platform API",
    notes: "Verified but deliberately not simulated by the local adapter.",
  }),
]);

export type BranchErrorCode =
  | "BRANCH_VALIDATION"
  | "BRANCH_FORBIDDEN"
  | "BRANCH_NOT_FOUND"
  | "BRANCH_CONFLICT"
  | "BRANCH_INFRASTRUCTURE";

export class BranchError extends Error {
  readonly code: BranchErrorCode;

  constructor(code: BranchErrorCode, message: string) {
    super(message);
    this.name = "BranchError";
    this.code = code;
  }
}

export type BranchService = Readonly<{
  createBranch(
    input: CreateBranchInput,
    actorId: string,
    correlationId: string,
  ): Promise<CreateBranchResult>;
  listBranches(parentTenant: TenantIdentity): readonly BranchRecord[];
  applyToBranch(
    tenant: TenantIdentity,
    artifact: MigrationArtifact,
    actorId: string,
    correlationId: string,
  ): Promise<Readonly<{ branch: BranchRecord; migrationHash: string; schemaHash: string }>>;
  promote(
    tenant: TenantIdentity,
    migrationHash: string,
    idempotencyKey: string,
    actorId: string,
    correlationId: string,
  ): Promise<PromotionResult>;
  deleteBranch(tenant: TenantIdentity, actorId: string, correlationId: string): Promise<void>;
  cleanupExpired(): Promise<readonly TenantIdentity[]>;
  handleRequest(request: Request, context: TenantContext): Promise<Response>;
  close(): void;
}>;

type BranchRow = Readonly<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
  parentOrganizationId: string;
  parentProjectId: string;
  parentEnvironmentId: string;
  parentBranchId: string;
  parentGeneration: number;
  state: BranchState;
  parentCheckpointJson: string;
  parentSchemaHash: string;
  branchSchemaHash: string;
  databasePath: string;
  credentialId: string;
  createdAt: number;
  expiresAt: number;
  promotedAt: number | null;
}>;

type PromotionRow = Readonly<{
  migrationHash: string;
  actorId: string;
  correlationId: string;
  state: "applying" | "applied";
  resultSchemaHash: string | null;
  restorePointJson: string | null;
}>;

type CreationRow = Readonly<{
  reservationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
  databasePath: string;
  checkpointPath: string;
  credentialId: string;
}>;

type BranchMigrationRow = Readonly<{
  migrationHash: string;
  artifactJson: string;
  correlationId: string;
  state: "applying" | "applied";
  resultSchemaHash: string | null;
}>;

type ApplyingPromotionRow = PromotionRow &
  Readonly<{
    organizationId: string;
    projectId: string;
    environmentId: string;
    branchId: string;
    generation: number;
    idempotencyKey: string;
  }>;

const idempotencyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const minimumTtlSeconds = 60;
const maximumTtlSeconds = 60 * 60 * 24 * 30;

export async function openBranchService(options: BranchServiceOptions): Promise<BranchService> {
  const catalogDirectory = resolve(options.catalogDirectory);
  const catalogPath = approvedPath(options.catalogPath, catalogDirectory, "Branch catalog");
  const databaseDirectory = resolve(options.databaseDirectory);
  const checkpointDirectory = resolve(options.checkpointDirectory);
  await Promise.all([
    mkdir(catalogDirectory, { recursive: true }),
    mkdir(databaseDirectory, { recursive: true }),
    mkdir(checkpointDirectory, { recursive: true }),
  ]);
  const catalog = new Database(catalogPath, { strict: true });
  const now = options.now ?? Date.now;

  try {
    configureCatalog(catalog);
    initializeCatalog(catalog);
  } catch (error) {
    catalog.close(false);
    throw error;
  }
  await reconcileInterruptedCreations(catalog, options, databaseDirectory, checkpointDirectory);
  reconcileInterruptedBranchStates(catalog, databaseDirectory);
  reconcileInterruptedPromotions(catalog, options, checkpointDirectory, now);

  const service: BranchService = {
    async createBranch(input, actorId, correlationId): Promise<CreateBranchResult> {
      validateOperationIdentity(actorId, correlationId, input.idempotencyKey);
      const parentTenant = parseTenantIdentity(input.parentTenant);
      const tenant = parseTenantIdentity(input.tenant);
      validateBranchLineage(parentTenant, tenant);
      validateTtl(input.ttlSeconds);
      const syntheticUsers = input.syntheticUsers ?? [];
      if (syntheticUsers.length > 100) {
        throw new BranchError("BRANCH_VALIDATION", "Preview synthetic user limit exceeded.");
      }
      const parent = options.resolveParent(parentTenant);
      if (!sameTenant(parent.tenant, parentTenant) || !parent.production) {
        throw new BranchError(
          "BRANCH_FORBIDDEN",
          "Branch parent must be the resolved production database.",
        );
      }
      const createdAt = now();
      const expiresAt = createdAt + input.ttlSeconds * 1000;
      const checkpointId = `branch-${tenant.branchId}-${tenant.generation}`;
      const checkpointPath = scopedPath(checkpointDirectory, tenant, "parent-checkpoint.sqlite");
      const databasePath = scopedPath(databaseDirectory, tenant, "database.sqlite");
      const stagingPath = scopedPath(databaseDirectory, tenant, "sanitizing.sqlite");
      const credentialId = `credential-${tenant.branchId}-${tenant.generation}-${crypto.randomUUID()}`;
      const reservationId = crypto.randomUUID();
      reserveBranchCreation(
        catalog,
        tenant,
        input.idempotencyKey,
        reservationId,
        databasePath,
        checkpointPath,
        credentialId,
        createdAt,
      );
      await Promise.all([
        mkdir(resolve(checkpointPath, ".."), { recursive: true }),
        mkdir(resolve(databasePath, ".."), { recursive: true }),
      ]);

      let credential: BranchCredential | undefined;
      try {
        const sourceSnapshot = parent.withMutationLock(() =>
          createCheckpoint(parent.storage, {
            id: checkpointId,
            checkpointPath,
            checkpointDirectory,
          }),
        );
        const stagingStorage = restoreCheckpoint(sourceSnapshot, {
          destinationPath: stagingPath,
          destinationDirectory: databaseDirectory,
          sourceDirectory: checkpointDirectory,
        });
        let parentCheckpoint: BackupArtifact;
        try {
          scrubPreviewData(stagingStorage);
          rmSyncFile(checkpointPath);
          parentCheckpoint = createCheckpoint(stagingStorage, {
            id: checkpointId,
            checkpointPath,
            checkpointDirectory,
          });
          createCheckpoint(stagingStorage, {
            id: `${checkpointId}-database`,
            checkpointPath: databasePath,
            checkpointDirectory: databaseDirectory,
          });
        } finally {
          stagingStorage.close();
          rmSyncFile(stagingPath);
        }
        const branchStorage = openStorageAdapter({ databasePath, databaseDirectory });
        let branchSchemaHash: string;
        try {
          branchSchemaHash = buildSchemaManifest(branchStorage).hash;
        } finally {
          branchStorage.close();
        }
        await options.auth.create(tenant, syntheticUsers);
        credential = await options.credentials.issue({ tenant, credentialId, expiresAt });
        validateCredential(credential, credentialId, tenant, expiresAt);
        const record = Object.freeze({
          formatVersion: branchCatalogFormatVersion,
          tenant,
          parentTenant,
          state: "active" as const,
          parentCheckpoint,
          parentSchemaHash: sourceSnapshot.sourceSchemaHash,
          branchSchemaHash,
          databasePath,
          credentialId: credential.id,
          createdAt,
          expiresAt,
          promotedAt: null,
        });
        const auditEvent = Object.freeze({
          action: "branch.create",
          actorId,
          tenant,
          parentTenant,
          correlationId,
          migrationHash: null,
          restorePointId: parentCheckpoint.id,
          occurredAt: now(),
        });
        catalog.transaction(() => {
          insertBranch(catalog, record, input.idempotencyKey);
          insertAudit(catalog, auditEvent);
          catalog
            .query<never, [string]>("DELETE FROM branch_creation WHERE reservation_id = ?")
            .run(reservationId);
        })();
        await deliverAudit(options.audit, auditEvent);
        return Object.freeze({ branch: record, credential });
      } catch (error) {
        const ownsReservation = hasCreationReservation(catalog, reservationId);
        if (ownsReservation) {
          try {
            await options.credentials.revoke({ tenant, credentialId });
            await options.auth.delete(tenant);
            await removeBranchFiles(databasePath, checkpointPath);
            catalog
              .query<never, [string]>("DELETE FROM branch_creation WHERE reservation_id = ?")
              .run(reservationId);
          } catch (_cleanupError) {
            // The reservation remains durable so startup reconciliation can retry cleanup.
          }
        }
        throw mapBranchError(error);
      }
    },

    listBranches(parentTenantInput): readonly BranchRecord[] {
      const parentTenant = parseTenantIdentity(parentTenantInput);
      return Object.freeze(
        catalog
          .query<BranchRow, [string, string, string, string, number, number]>(`
            SELECT ${branchColumns}
            FROM branch
            WHERE parent_organization_id = ? AND parent_project_id = ? AND parent_environment_id = ?
              AND parent_branch_id = ? AND parent_generation = ? AND state != 'deleting'
              AND expires_at > ?
            ORDER BY created_at, branch_id, generation
          `)
          .all(...tenantParameters(parentTenant), now())
          .map(branchFromRow),
      );
    },

    async applyToBranch(tenantInput, artifact, actorId, correlationId) {
      validateOperationIdentity(actorId, correlationId, artifact.idempotencyKey);
      validateMigrationArtifactForJournal(artifact);
      const tenant = parseTenantIdentity(tenantInput);
      const current = requireBranch(catalog, tenant);
      if (current.expiresAt <= now()) {
        throw new BranchError("BRANCH_CONFLICT", "Preview branch has expired.");
      }
      if (current.state !== "active") {
        throw new BranchError("BRANCH_CONFLICT", "Only an active preview branch can be migrated.");
      }
      if (artifact.expectedSchemaHash !== current.branchSchemaHash) {
        throw new BranchError(
          "BRANCH_CONFLICT",
          "Migration was not created for the current branch schema.",
        );
      }
      if (artifact.actorId !== actorId) {
        throw new BranchError(
          "BRANCH_FORBIDDEN",
          "Migration actor does not match the authenticated actor.",
        );
      }
      catalog.transaction(() => {
        const existingMigration = readOnlyBranchMigration(catalog, tenant);
        if (existingMigration && existingMigration.hash !== artifact.hash) {
          throw new BranchError(
            "BRANCH_CONFLICT",
            "A preview branch can validate only one migration artifact in this lifecycle version.",
          );
        }
        if (!existingMigration) {
          insertBranchMigration(catalog, tenant, artifact, correlationId, now());
        }
        const claimed = catalog
          .query<never, [string, string, string, string, number, number]>(`
            UPDATE branch SET state = 'migrating'
            WHERE organization_id = ? AND project_id = ? AND environment_id = ?
              AND branch_id = ? AND generation = ? AND state = 'active' AND expires_at > ?
          `)
          .run(...tenantParameters(tenant), now());
        if (claimed.changes !== 1) {
          throw new BranchError("BRANCH_CONFLICT", "Branch state changed before migration.");
        }
      })();
      const storage = openStorageAdapter({ databasePath: current.databasePath, databaseDirectory });
      try {
        const result = applyMigration(storage, artifact);
        const auditEvent = Object.freeze({
          action: "branch.migrate" as const,
          actorId,
          tenant,
          parentTenant: current.parentTenant,
          correlationId,
          migrationHash: artifact.hash,
          restorePointId: null,
          occurredAt: now(),
        });
        catalog.transaction(() => {
          catalog
            .query<never, [string, number, string, string, string, string, number, string]>(`
              UPDATE branch_migration SET state = 'applied', result_schema_hash = ?, updated_at = ?
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND migration_hash = ? AND state = 'applying'
            `)
            .run(result.schemaHash, now(), ...tenantParameters(tenant), artifact.hash);
          const updated = catalog
            .query<never, [string, string, string, string, string, number]>(`
              UPDATE branch SET branch_schema_hash = ?, state = 'active'
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND state = 'migrating'
            `)
            .run(result.schemaHash, ...tenantParameters(tenant));
          if (updated.changes !== 1) {
            throw new BranchError("BRANCH_CONFLICT", "Branch state changed during migration.");
          }
          insertAudit(catalog, auditEvent);
        })();
        const branch = requireBranch(catalog, tenant);
        await deliverAudit(options.audit, auditEvent);
        return Object.freeze({
          branch,
          migrationHash: artifact.hash,
          schemaHash: result.schemaHash,
        });
      } catch (error) {
        if (!isMigrationApplied(storage, artifact)) {
          catalog.transaction(() => {
            catalog
              .query<never, [string, string, string, string, number, string]>(`
                DELETE FROM branch_migration
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND migration_hash = ? AND state = 'applying'
              `)
              .run(...tenantParameters(tenant), artifact.hash);
            catalog
              .query<never, [string, string, string, string, number]>(`
                UPDATE branch SET state = 'active'
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND state = 'migrating'
              `)
              .run(...tenantParameters(tenant));
          })();
        }
        throw mapBranchError(error);
      } finally {
        storage.close();
      }
    },

    async promote(tenantInput, migrationHash, idempotencyKey, actorId, correlationId) {
      validateOperationIdentity(actorId, correlationId, idempotencyKey);
      if (!hashPattern.test(migrationHash)) {
        throw new BranchError("BRANCH_VALIDATION", "Migration hash is invalid.");
      }
      const tenant = parseTenantIdentity(tenantInput);
      let branch = requireBranch(catalog, tenant);
      const existingPromotion = readPromotion(catalog, tenant, idempotencyKey);
      if (existingPromotion) {
        if (existingPromotion.migrationHash !== migrationHash) {
          throw new BranchError("BRANCH_CONFLICT", "Promotion idempotency key was reused.");
        }
        if (existingPromotion.actorId !== actorId) {
          throw new BranchError("BRANCH_FORBIDDEN", "Promotion retry actor does not match.");
        }
        if (
          existingPromotion.state === "applied" &&
          existingPromotion.resultSchemaHash &&
          existingPromotion.restorePointJson
        ) {
          return Object.freeze({
            status: "replayed" as const,
            branch,
            migrationHash,
            schemaHash: existingPromotion.resultSchemaHash,
            restorePoint: parseBackup(existingPromotion.restorePointJson),
          });
        }
        if (branch.state !== "promoting") {
          throw new BranchError("BRANCH_CONFLICT", "Promotion state is inconsistent.");
        }
      }

      const sourceArtifact = readBranchMigration(catalog, tenant, migrationHash);
      const parent = options.resolveParent(branch.parentTenant);
      if (!sameTenant(parent.tenant, branch.parentTenant) || !parent.production) {
        throw new BranchError(
          "BRANCH_FORBIDDEN",
          "Promotion target is not the resolved production database.",
        );
      }
      const restorePointId = `restore-${tenant.branchId}-${tenant.generation}-${migrationHash.slice(0, 24)}`;
      const restorePointPath = scopedPath(
        checkpointDirectory,
        branch.parentTenant,
        `${restorePointId}.sqlite`,
      );
      await mkdir(resolve(restorePointPath, ".."), { recursive: true });
      const targetArtifact = createMigrationArtifact({
        id: `promotion-${migrationHash.slice(0, 32)}`,
        actorId,
        idempotencyKey,
        expectedSchemaHash: branch.parentSchemaHash,
        sql: sourceArtifact.sql,
      });

      if (!existingPromotion) {
        if (branch.expiresAt <= now() || branch.state !== "active") {
          throw new BranchError(
            "BRANCH_CONFLICT",
            "Branch cannot be promoted from its current state.",
          );
        }
        catalog.transaction(() => {
          const claimed = catalog
            .query<never, [string, string, string, string, number, number]>(`
              UPDATE branch SET state = 'promoting'
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND state = 'active' AND expires_at > ?
            `)
            .run(...tenantParameters(tenant), now());
          if (claimed.changes !== 1) {
            throw new BranchError("BRANCH_CONFLICT", "Branch state changed before promotion.");
          }
          insertPromotion(
            catalog,
            tenant,
            migrationHash,
            idempotencyKey,
            actorId,
            correlationId,
            now(),
          );
        })();
        branch = requireBranch(catalog, tenant);
      }

      try {
        const operation = parent.withMutationLock(() => {
          const currentPromotion = readPromotion(catalog, tenant, idempotencyKey);
          let restorePoint = currentPromotion?.restorePointJson
            ? parseBackup(currentPromotion.restorePointJson)
            : null;
          if (!restorePoint) {
            if (buildSchemaManifest(parent.storage).hash !== branch.parentSchemaHash) {
              throw new BranchError(
                "BRANCH_CONFLICT",
                "Promotion target changed after branch creation.",
              );
            }
            if (existsSync(restorePointPath)) rmSyncFile(restorePointPath);
            restorePoint = createCheckpoint(parent.storage, {
              id: restorePointId,
              checkpointPath: restorePointPath,
              checkpointDirectory,
            });
            const persisted = catalog
              .query<never, [string, number, string, string, string, string, number, string]>(`
                UPDATE branch_promotion SET restore_point_json = ?, updated_at = ?
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND idempotency_key = ? AND state = 'applying'
              `)
              .run(
                JSON.stringify(restorePoint),
                now(),
                ...tenantParameters(tenant),
                idempotencyKey,
              );
            if (persisted.changes !== 1) {
              throw new BranchError("BRANCH_CONFLICT", "Promotion state changed before apply.");
            }
          }
          const result = applyMigration(parent.storage, targetArtifact, {
            checkpoint: restorePoint,
          });
          return Object.freeze({ result, restorePoint });
        });
        const promotedAt = now();
        const auditEvent = Object.freeze({
          action: "branch.promote" as const,
          actorId,
          tenant,
          parentTenant: branch.parentTenant,
          correlationId,
          migrationHash,
          restorePointId: operation.restorePoint.id,
          occurredAt: promotedAt,
        });
        catalog.transaction(() => {
          const promotionUpdated = catalog
            .query<
              never,
              [string, string, number, string, string, string, string, number, string]
            >(`
              UPDATE branch_promotion
              SET state = 'applied', result_schema_hash = ?, restore_point_json = ?, updated_at = ?
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND idempotency_key = ? AND state = 'applying'
            `)
            .run(
              operation.result.schemaHash,
              JSON.stringify(operation.restorePoint),
              promotedAt,
              ...tenantParameters(tenant),
              idempotencyKey,
            );
          const branchUpdated = catalog
            .query<never, [number, string, string, string, string, number]>(`
              UPDATE branch SET state = 'promoted', promoted_at = ?
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND state = 'promoting'
            `)
            .run(promotedAt, ...tenantParameters(tenant));
          if (promotionUpdated.changes !== 1 || branchUpdated.changes !== 1) {
            throw new BranchError("BRANCH_CONFLICT", "Promotion state changed during commit.");
          }
          insertAudit(catalog, auditEvent);
        })();
        const promoted = requireBranch(catalog, tenant);
        await deliverAudit(options.audit, auditEvent);
        return Object.freeze({
          status: operation.result.status,
          branch: promoted,
          migrationHash,
          schemaHash: operation.result.schemaHash,
          restorePoint: operation.restorePoint,
        });
      } catch (error) {
        const promotion = readPromotion(catalog, tenant, idempotencyKey);
        if (!isMigrationApplied(parent.storage, targetArtifact)) {
          const restorePoint = promotion?.restorePointJson
            ? parseBackup(promotion.restorePointJson)
            : null;
          if (restorePoint) {
            const path = approvedPath(
              restorePoint.checkpointPath,
              checkpointDirectory,
              "Promotion restore point",
            );
            rmSyncFile(path);
          } else if (existsSync(restorePointPath)) {
            rmSyncFile(restorePointPath);
          }
          catalog.transaction(() => {
            catalog
              .query<never, [string, string, string, string, number, string]>(`
                DELETE FROM branch_promotion
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND idempotency_key = ?
                  AND state = 'applying'
              `)
              .run(...tenantParameters(tenant), idempotencyKey);
            catalog
              .query<never, [string, string, string, string, number]>(`
                UPDATE branch SET state = 'active'
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND state = 'promoting'
              `)
              .run(...tenantParameters(tenant));
          })();
        }
        throw mapBranchError(error);
      }
    },

    async deleteBranch(tenantInput, actorId, correlationId): Promise<void> {
      validateOperationIdentity(actorId, correlationId);
      const tenant = parseTenantIdentity(tenantInput);
      await deleteBranchInternal(
        catalog,
        options,
        databaseDirectory,
        checkpointDirectory,
        tenant,
        actorId,
        correlationId,
        now,
      );
    },

    async cleanupExpired(): Promise<readonly TenantIdentity[]> {
      const cutoff = now();
      const candidates = catalog
        .query<BranchRow, [number]>(`
          SELECT ${branchColumns} FROM branch
          WHERE (expires_at <= ? AND state IN ('active', 'promoted')) OR state = 'deleting'
          ORDER BY expires_at
        `)
        .all(cutoff)
        .map(branchFromRow);
      const deleted: TenantIdentity[] = [];
      for (const branch of candidates) {
        if (branch.state !== "deleting") {
          const claimed = catalog
            .query<never, [string, string, string, string, number, number]>(`
              UPDATE branch SET state = 'deleting'
              WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                AND branch_id = ? AND generation = ? AND expires_at = ?
                AND state IN ('active', 'promoted')
            `)
            .run(...tenantParameters(branch.tenant), branch.expiresAt);
          if (claimed.changes !== 1) continue;
        }
        const removed = await deleteClaimedBranch(
          catalog,
          options,
          databaseDirectory,
          checkpointDirectory,
          branch,
          "service-ttl-cleanup",
          "ttl-cleanup",
          now,
        );
        if (removed) deleted.push(branch.tenant);
      }
      return Object.freeze(deleted);
    },

    async handleRequest(request, context): Promise<Response> {
      try {
        const url = new URL(request.url);
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments[0] !== "branches") throw new ProtocolError("validation");

        if (request.method === "POST" && segments.length === 1) {
          requireCapability(context, "branch:create", now());
          const body = await readJsonRecord(request);
          const result = await service.createBranch(
            {
              tenant: readTenantIdentity(body.tenant),
              parentTenant: context.tenant,
              ttlSeconds: readInteger(body, "ttlSeconds"),
              idempotencyKey: readString(body, "idempotencyKey"),
              ...(Array.isArray(body.syntheticUsers)
                ? { syntheticUsers: body.syntheticUsers.map(readSyntheticUser) }
                : {}),
            },
            context.actor.id,
            context.correlationId,
          );
          return jsonResponse(
            {
              branch: publicBranch(result.branch),
              credential: {
                token: result.credential.token,
                url: result.credential.url,
                expiresAt: result.credential.expiresAt,
                tenant: result.credential.tenant,
              },
            },
            201,
            { "cache-control": "no-store" },
          );
        }
        if (request.method === "GET" && segments.length === 1) {
          requireCapability(context, "branch:list", now());
          return jsonResponse({ branches: service.listBranches(context.tenant).map(publicBranch) });
        }

        const branchId = parseBranchId(segments[1]);
        const generation = parseGeneration(readPositiveInteger(url.searchParams.get("generation")));
        const environmentId = readRequiredQuery(url, "environmentId");
        const tenant = parseTenantIdentity({
          organizationId: context.tenant.organizationId,
          projectId: context.tenant.projectId,
          environmentId,
          branchId,
          generation,
        });
        const target = requireBranch(catalog, tenant);
        if (!sameTenant(target.parentTenant, context.tenant)) {
          throw new ProtocolError("forbidden");
        }

        if (request.method === "DELETE" && segments.length === 2) {
          requireCapability(context, "branch:delete", now());
          await service.deleteBranch(tenant, context.actor.id, context.correlationId);
          return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && segments[2] === "migrations" && segments.length === 3) {
          requireCapability(context, "branch:migrate", now());
          const body = await readJsonRecord(request);
          const result = await service.applyToBranch(
            tenant,
            readMigrationArtifact(body.artifact),
            context.actor.id,
            context.correlationId,
          );
          return jsonResponse({ ...result, branch: publicBranch(result.branch) });
        }
        if (request.method === "POST" && segments[2] === "promotions" && segments.length === 3) {
          requireCapability(context, "branch:promote", now());
          const body = await readJsonRecord(request);
          const result = await service.promote(
            tenant,
            readString(body, "migrationHash"),
            readString(body, "idempotencyKey"),
            context.actor.id,
            context.correlationId,
          );
          return jsonResponse({
            status: result.status,
            branch: publicBranch(result.branch),
            migrationHash: result.migrationHash,
            schemaHash: result.schemaHash,
            restorePointId: result.restorePoint.id,
          });
        }
        throw new ProtocolError("validation");
      } catch (error) {
        const protocolError = toProtocolError(error);
        const statusByCode: Record<ProtocolError["code"], number> = {
          validation: 400,
          auth: 401,
          forbidden: 403,
          conflict: 409,
          quota: 429,
          unsupported: 501,
          infrastructure: 503,
        };
        const status = statusByCode[protocolError.code];
        return jsonResponse(createErrorEnvelope(protocolError.code, context.correlationId), status);
      }
    },

    close(): void {
      catalog.close(false);
    },
  };

  return Object.freeze(service);
}

const branchColumns = `
  organization_id AS organizationId, project_id AS projectId,
  environment_id AS environmentId, branch_id AS branchId, generation,
  parent_organization_id AS parentOrganizationId, parent_project_id AS parentProjectId,
  parent_environment_id AS parentEnvironmentId, parent_branch_id AS parentBranchId,
  parent_generation AS parentGeneration, state,
  parent_checkpoint_json AS parentCheckpointJson, parent_schema_hash AS parentSchemaHash,
  branch_schema_hash AS branchSchemaHash, database_path AS databasePath,
  credential_id AS credentialId, created_at AS createdAt, expires_at AS expiresAt,
  promoted_at AS promotedAt
`;

function configureCatalog(database: Database): void {
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = FULL");
  database.run("PRAGMA busy_timeout = 5000");
}

function initializeCatalog(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS branch (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      parent_organization_id TEXT NOT NULL,
      parent_project_id TEXT NOT NULL,
      parent_environment_id TEXT NOT NULL,
      parent_branch_id TEXT NOT NULL,
      parent_generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'migrating', 'promoting', 'promoted', 'deleting', 'deleting_active')),
      parent_checkpoint_json TEXT NOT NULL,
      parent_schema_hash TEXT NOT NULL,
      branch_schema_hash TEXT NOT NULL,
      database_path TEXT NOT NULL UNIQUE,
      credential_id TEXT NOT NULL UNIQUE,
      create_idempotency_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      promoted_at INTEGER,
      PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation)
    ) STRICT
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS branch_migration (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      migration_hash TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
      result_schema_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation, migration_hash),
      FOREIGN KEY (organization_id, project_id, environment_id, branch_id, generation)
        REFERENCES branch (organization_id, project_id, environment_id, branch_id, generation)
        ON DELETE CASCADE
    ) STRICT
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS branch_promotion (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      migration_hash TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
      result_schema_hash TEXT,
      restore_point_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation, idempotency_key),
      FOREIGN KEY (organization_id, project_id, environment_id, branch_id, generation)
        REFERENCES branch (organization_id, project_id, environment_id, branch_id, generation)
        ON DELETE CASCADE
    ) STRICT
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS branch_creation (
      reservation_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      database_path TEXT NOT NULL,
      checkpoint_path TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (organization_id, project_id, environment_id, branch_id, generation)
    ) STRICT
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS branch_audit (
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      correlation_id TEXT NOT NULL,
      action TEXT NOT NULL,
      event_json TEXT NOT NULL,
      delivered_at INTEGER,
      PRIMARY KEY (
        organization_id, project_id, environment_id, branch_id, generation, correlation_id, action
      )
    ) STRICT
  `);
}

function insertBranch(database: Database, branch: BranchRecord, idempotencyKey: string): void {
  try {
    database
      .query<never, (string | number | null)[]>(`
        INSERT INTO branch (
          organization_id, project_id, environment_id, branch_id, generation,
          parent_organization_id, parent_project_id, parent_environment_id, parent_branch_id,
          parent_generation, state, parent_checkpoint_json, parent_schema_hash, branch_schema_hash,
          database_path, credential_id, create_idempotency_key, created_at, expires_at, promoted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        ...tenantParameters(branch.tenant),
        ...tenantParameters(branch.parentTenant),
        branch.state,
        JSON.stringify(branch.parentCheckpoint),
        branch.parentSchemaHash,
        branch.branchSchemaHash,
        branch.databasePath,
        branch.credentialId,
        idempotencyKey,
        branch.createdAt,
        branch.expiresAt,
        branch.promotedAt,
      );
  } catch (_error) {
    throw new BranchError("BRANCH_CONFLICT", "Branch catalog rejected a duplicate resource.");
  }
}

function readBranch(database: Database, tenant: TenantIdentity): BranchRecord | null {
  const row = database
    .query<BranchRow, [string, string, string, string, number]>(`
      SELECT ${branchColumns} FROM branch
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ?
    `)
    .get(...tenantParameters(tenant));
  return row ? branchFromRow(row) : null;
}

function requireBranch(database: Database, tenant: TenantIdentity): BranchRecord {
  const branch = readBranch(database, tenant);
  if (!branch) throw new BranchError("BRANCH_NOT_FOUND", "Preview branch was not found.");
  return branch;
}

function branchFromRow(row: BranchRow): BranchRecord {
  return Object.freeze({
    formatVersion: branchCatalogFormatVersion,
    tenant: parseTenantIdentity({
      organizationId: row.organizationId,
      projectId: row.projectId,
      environmentId: row.environmentId,
      branchId: row.branchId,
      generation: row.generation,
    }),
    parentTenant: parseTenantIdentity({
      organizationId: row.parentOrganizationId,
      projectId: row.parentProjectId,
      environmentId: row.parentEnvironmentId,
      branchId: row.parentBranchId,
      generation: row.parentGeneration,
    }),
    state: row.state,
    parentCheckpoint: parseBackup(row.parentCheckpointJson),
    parentSchemaHash: row.parentSchemaHash,
    branchSchemaHash: row.branchSchemaHash,
    databasePath: row.databasePath,
    credentialId: row.credentialId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    promotedAt: row.promotedAt,
  });
}

function readBranchMigration(
  database: Database,
  tenant: TenantIdentity,
  migrationHash: string,
): MigrationArtifact {
  const row = database
    .query<{ artifactJson: string }, [string, string, string, string, number, string]>(`
      SELECT artifact_json AS artifactJson FROM branch_migration
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND migration_hash = ? AND state = 'applied'
    `)
    .get(...tenantParameters(tenant), migrationHash);
  if (!row) throw new BranchError("BRANCH_NOT_FOUND", "Validated branch migration was not found.");
  return readMigrationArtifact(JSON.parse(row.artifactJson));
}

function readOnlyBranchMigration(
  database: Database,
  tenant: TenantIdentity,
): MigrationArtifact | null {
  const rows = database
    .query<BranchMigrationRow, [string, string, string, string, number]>(`
      SELECT migration_hash AS migrationHash, artifact_json AS artifactJson,
        correlation_id AS correlationId, state, result_schema_hash AS resultSchemaHash
      FROM branch_migration
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ?
      ORDER BY created_at, migration_hash
      LIMIT 2
    `)
    .all(...tenantParameters(tenant));
  if (rows.length > 1) {
    throw new BranchError(
      "BRANCH_CONFLICT",
      "Branch migration history exceeds the supported lifecycle version.",
    );
  }
  return rows[0] ? readMigrationArtifact(JSON.parse(rows[0].artifactJson)) : null;
}

function readBranchMigrationJournal(
  database: Database,
  tenant: TenantIdentity,
): Readonly<{ artifact: MigrationArtifact; correlationId: string }> {
  const rows = database
    .query<BranchMigrationRow, [string, string, string, string, number]>(`
      SELECT migration_hash AS migrationHash, artifact_json AS artifactJson,
        correlation_id AS correlationId, state, result_schema_hash AS resultSchemaHash
      FROM branch_migration
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND state = 'applying'
      ORDER BY created_at, migration_hash
      LIMIT 2
    `)
    .all(...tenantParameters(tenant));
  if (rows.length !== 1) {
    throw new BranchError("BRANCH_INFRASTRUCTURE", "Branch migration journal is invalid.");
  }
  return Object.freeze({
    artifact: readMigrationArtifact(JSON.parse(rows[0]?.artifactJson ?? "null")),
    correlationId: rows[0]?.correlationId ?? "",
  });
}

function insertBranchMigration(
  database: Database,
  tenant: TenantIdentity,
  artifact: MigrationArtifact,
  correlationId: string,
  timestamp: number,
): void {
  database
    .query<never, (string | number)[]>(`
      INSERT INTO branch_migration (
        organization_id, project_id, environment_id, branch_id, generation,
        migration_hash, artifact_json, correlation_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applying', ?, ?)
    `)
    .run(
      ...tenantParameters(tenant),
      artifact.hash,
      JSON.stringify(artifact),
      correlationId,
      timestamp,
      timestamp,
    );
}

function reserveBranchCreation(
  database: Database,
  tenant: TenantIdentity,
  idempotencyKey: string,
  reservationId: string,
  databasePath: string,
  checkpointPath: string,
  credentialId: string,
  createdAt: number,
): void {
  try {
    database.transaction(() => {
      const existing = database
        .query<{ found: number }, [string, string, string, string, number]>(`
          SELECT 1 AS found FROM branch
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ?
        `)
        .get(...tenantParameters(tenant));
      if (existing) {
        throw new BranchError("BRANCH_CONFLICT", "Branch generation already exists.");
      }
      database
        .query<never, (string | number)[]>(`
          INSERT INTO branch_creation (
            reservation_id, organization_id, project_id, environment_id, branch_id, generation,
            idempotency_key, database_path, checkpoint_path, credential_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          reservationId,
          ...tenantParameters(tenant),
          idempotencyKey,
          databasePath,
          checkpointPath,
          credentialId,
          createdAt,
        );
    })();
  } catch (_error) {
    throw new BranchError("BRANCH_CONFLICT", "Branch generation is already being created.");
  }
}

function reconcileInterruptedBranchStates(database: Database, databaseDirectory: string): void {
  database.run("UPDATE branch SET state = 'deleting' WHERE state = 'deleting_active'");
  const migrating = database
    .query<BranchRow, []>(`SELECT ${branchColumns} FROM branch WHERE state = 'migrating'`)
    .all()
    .map(branchFromRow);
  for (const branch of migrating) {
    const databasePath = approvedPath(branch.databasePath, databaseDirectory, "Branch database");
    const storage = openStorageAdapter({ databasePath, databaseDirectory });
    try {
      const migration = readBranchMigrationJournal(database, branch.tenant);
      let result: ReturnType<typeof applyMigration>;
      try {
        result = applyMigration(storage, migration.artifact);
      } catch (_error) {
        if (!isMigrationApplied(storage, migration.artifact)) {
          database.transaction(() => {
            database
              .query<never, [string, string, string, string, number, string]>(`
                DELETE FROM branch_migration
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND migration_hash = ? AND state = 'applying'
              `)
              .run(...tenantParameters(branch.tenant), migration.artifact.hash);
            database
              .query<never, [string, string, string, string, number]>(`
                UPDATE branch SET state = 'active'
                WHERE organization_id = ? AND project_id = ? AND environment_id = ?
                  AND branch_id = ? AND generation = ? AND state = 'migrating'
              `)
              .run(...tenantParameters(branch.tenant));
          })();
        }
        continue;
      }
      const auditEvent = Object.freeze({
        action: "branch.migrate" as const,
        actorId: migration.artifact.actorId,
        tenant: branch.tenant,
        parentTenant: branch.parentTenant,
        correlationId: migration.correlationId,
        migrationHash: migration.artifact.hash,
        restorePointId: null,
        occurredAt: Date.now(),
      });
      database.transaction(() => {
        database
          .query<never, [string, number, string, string, string, string, number, string]>(`
            UPDATE branch_migration SET state = 'applied', result_schema_hash = ?, updated_at = ?
            WHERE organization_id = ? AND project_id = ? AND environment_id = ?
              AND branch_id = ? AND generation = ? AND migration_hash = ?
          `)
          .run(
            result.schemaHash,
            Date.now(),
            ...tenantParameters(branch.tenant),
            migration.artifact.hash,
          );
        database
          .query<never, [string, string, string, string, string, number]>(`
            UPDATE branch SET branch_schema_hash = ?, state = 'active'
            WHERE organization_id = ? AND project_id = ? AND environment_id = ?
              AND branch_id = ? AND generation = ? AND state = 'migrating'
          `)
          .run(result.schemaHash, ...tenantParameters(branch.tenant));
        insertAudit(database, auditEvent);
      })();
    } finally {
      storage.close();
    }
  }
}

function reconcileInterruptedPromotions(
  database: Database,
  options: BranchServiceOptions,
  checkpointDirectory: string,
  now: () => number,
): void {
  const promotions = database
    .query<ApplyingPromotionRow, []>(`
      SELECT organization_id AS organizationId, project_id AS projectId,
        environment_id AS environmentId, branch_id AS branchId, generation,
        idempotency_key AS idempotencyKey, migration_hash AS migrationHash,
        actor_id AS actorId, correlation_id AS correlationId, state,
        result_schema_hash AS resultSchemaHash, restore_point_json AS restorePointJson
      FROM branch_promotion WHERE state = 'applying'
    `)
    .all();
  for (const promotion of promotions) {
    const tenant = parseTenantIdentity({
      organizationId: promotion.organizationId,
      projectId: promotion.projectId,
      environmentId: promotion.environmentId,
      branchId: promotion.branchId,
      generation: promotion.generation,
    });
    const branch = requireBranch(database, tenant);
    const sourceArtifact = readBranchMigration(database, tenant, promotion.migrationHash);
    const targetArtifact = createMigrationArtifact({
      id: `promotion-${promotion.migrationHash.slice(0, 32)}`,
      actorId: promotion.actorId,
      idempotencyKey: promotion.idempotencyKey,
      expectedSchemaHash: branch.parentSchemaHash,
      sql: sourceArtifact.sql,
    });
    const parent = options.resolveParent(branch.parentTenant);
    if (!sameTenant(parent.tenant, branch.parentTenant) || !parent.production) continue;

    const appliedSchemaHash = parent.withMutationLock(() => {
      if (!isMigrationApplied(parent.storage, targetArtifact)) return null;
      return buildSchemaManifest(parent.storage).hash;
    });
    if (appliedSchemaHash && promotion.restorePointJson) {
      const restorePoint = parseBackup(promotion.restorePointJson);
      const auditEvent = Object.freeze({
        action: "branch.promote" as const,
        actorId: promotion.actorId,
        tenant,
        parentTenant: branch.parentTenant,
        correlationId: promotion.correlationId,
        migrationHash: promotion.migrationHash,
        restorePointId: restorePoint.id,
        occurredAt: now(),
      });
      database.transaction(() => {
        database
          .query<never, [string, number, string, string, string, string, number, string]>(`
            UPDATE branch_promotion SET state = 'applied', result_schema_hash = ?, updated_at = ?
            WHERE organization_id = ? AND project_id = ? AND environment_id = ?
              AND branch_id = ? AND generation = ? AND idempotency_key = ? AND state = 'applying'
          `)
          .run(appliedSchemaHash, now(), ...tenantParameters(tenant), promotion.idempotencyKey);
        database
          .query<never, [number, string, string, string, string, number]>(`
            UPDATE branch SET state = 'promoted', promoted_at = ?
            WHERE organization_id = ? AND project_id = ? AND environment_id = ?
              AND branch_id = ? AND generation = ? AND state = 'promoting'
          `)
          .run(now(), ...tenantParameters(tenant));
        insertAudit(database, auditEvent);
      })();
      continue;
    }

    const restorePointPath = promotion.restorePointJson
      ? approvedPath(
          parseBackup(promotion.restorePointJson).checkpointPath,
          checkpointDirectory,
          "Promotion restore point",
        )
      : scopedPath(
          checkpointDirectory,
          branch.parentTenant,
          `restore-${tenant.branchId}-${tenant.generation}-${promotion.migrationHash.slice(0, 24)}.sqlite`,
        );
    if (existsSync(restorePointPath)) rmSyncFile(restorePointPath);
    database.transaction(() => {
      database
        .query<never, [string, string, string, string, number, string]>(`
          DELETE FROM branch_promotion
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ? AND idempotency_key = ? AND state = 'applying'
        `)
        .run(...tenantParameters(tenant), promotion.idempotencyKey);
      database
        .query<never, [string, string, string, string, number]>(`
          UPDATE branch SET state = 'active'
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ? AND state = 'promoting'
        `)
        .run(...tenantParameters(tenant));
    })();
  }
}

function hasCreationReservation(database: Database, reservationId: string): boolean {
  return (
    database
      .query<{ found: number }, [string]>(
        "SELECT 1 AS found FROM branch_creation WHERE reservation_id = ?",
      )
      .get(reservationId)?.found === 1
  );
}

async function reconcileInterruptedCreations(
  database: Database,
  options: BranchServiceOptions,
  databaseDirectory: string,
  checkpointDirectory: string,
): Promise<void> {
  const rows = database
    .query<CreationRow, []>(`
      SELECT reservation_id AS reservationId, organization_id AS organizationId,
        project_id AS projectId, environment_id AS environmentId, branch_id AS branchId,
        generation, database_path AS databasePath, checkpoint_path AS checkpointPath,
        credential_id AS credentialId
      FROM branch_creation
    `)
    .all();
  for (const row of rows) {
    const tenant = parseTenantIdentity({
      organizationId: row.organizationId,
      projectId: row.projectId,
      environmentId: row.environmentId,
      branchId: row.branchId,
      generation: row.generation,
    });
    await options.credentials.revoke({ tenant, credentialId: row.credentialId });
    await options.auth.delete(tenant);
    const databasePath = approvedPath(row.databasePath, databaseDirectory, "Branch database");
    const checkpointPath = approvedPath(
      row.checkpointPath,
      checkpointDirectory,
      "Branch checkpoint",
    );
    await removeBranchFiles(databasePath, checkpointPath);
    database
      .query<never, [string]>("DELETE FROM branch_creation WHERE reservation_id = ?")
      .run(row.reservationId);
  }
}

async function removeBranchFiles(databasePath: string, checkpointPath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(checkpointPath, { force: true }),
  ]);
  await Promise.all([
    rm(resolve(databasePath, ".."), { force: true, recursive: true }),
    rm(resolve(checkpointPath, ".."), { force: true, recursive: true }),
  ]);
}

function rmSyncFile(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function insertPromotion(
  database: Database,
  tenant: TenantIdentity,
  migrationHash: string,
  idempotencyKey: string,
  actorId: string,
  correlationId: string,
  timestamp: number,
): void {
  database
    .query<never, (string | number)[]>(`
      INSERT INTO branch_promotion (
        organization_id, project_id, environment_id, branch_id, generation,
        idempotency_key, migration_hash, actor_id, correlation_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applying', ?, ?)
    `)
    .run(
      ...tenantParameters(tenant),
      idempotencyKey,
      migrationHash,
      actorId,
      correlationId,
      timestamp,
      timestamp,
    );
}

function readPromotion(
  database: Database,
  tenant: TenantIdentity,
  idempotencyKey: string,
): PromotionRow | null {
  return (
    database
      .query<PromotionRow, [string, string, string, string, number, string]>(`
        SELECT migration_hash AS migrationHash, actor_id AS actorId,
          correlation_id AS correlationId, state,
          result_schema_hash AS resultSchemaHash, restore_point_json AS restorePointJson
        FROM branch_promotion
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND idempotency_key = ?
      `)
      .get(...tenantParameters(tenant), idempotencyKey) ?? null
  );
}

function readPromotionRestorePoints(
  database: Database,
  tenant: TenantIdentity,
): readonly BackupArtifact[] {
  return database
    .query<{ restorePointJson: string }, [string, string, string, string, number]>(`
      SELECT restore_point_json AS restorePointJson FROM branch_promotion
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND restore_point_json IS NOT NULL
    `)
    .all(...tenantParameters(tenant))
    .map((row) => parseBackup(row.restorePointJson));
}

async function deleteBranchInternal(
  catalog: Database,
  options: BranchServiceOptions,
  databaseDirectory: string,
  checkpointDirectory: string,
  tenant: TenantIdentity,
  actorId: string,
  correlationId: string,
  now: () => number,
): Promise<void> {
  const branch = requireBranch(catalog, tenant);
  if (branch.state !== "deleting") {
    const claimed = catalog
      .query<never, [string, string, string, string, number]>(`
        UPDATE branch SET state = 'deleting'
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND state IN ('active', 'promoted')
      `)
      .run(...tenantParameters(tenant));
    if (claimed.changes !== 1) {
      throw new BranchError("BRANCH_CONFLICT", "Branch has an in-flight mutation.");
    }
  }
  const removed = await deleteClaimedBranch(
    catalog,
    options,
    databaseDirectory,
    checkpointDirectory,
    { ...branch, state: "deleting" },
    actorId,
    correlationId,
    now,
  );
  if (!removed) {
    throw new BranchError("BRANCH_CONFLICT", "Branch deletion is already in progress.");
  }
}

async function deleteClaimedBranch(
  catalog: Database,
  options: BranchServiceOptions,
  databaseDirectory: string,
  checkpointDirectory: string,
  branch: BranchRecord,
  actorId: string,
  correlationId: string,
  now: () => number,
): Promise<boolean> {
  const claimed = catalog
    .query<never, [string, string, string, string, number]>(`
      UPDATE branch SET state = 'deleting_active'
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND state = 'deleting'
    `)
    .run(...tenantParameters(branch.tenant));
  if (claimed.changes !== 1) return false;
  try {
    await options.credentials.revoke({
      tenant: branch.tenant,
      credentialId: branch.credentialId,
    });
    await options.auth.delete(branch.tenant);
    const databasePath = approvedPath(branch.databasePath, databaseDirectory, "Branch database");
    const parentCheckpointPath = approvedPath(
      branch.parentCheckpoint.checkpointPath,
      checkpointDirectory,
      "Branch checkpoint",
    );
    const restorePoints = readPromotionRestorePoints(catalog, branch.tenant).map((backup) =>
      approvedPath(backup.checkpointPath, checkpointDirectory, "Promotion restore point"),
    );
    await removeBranchFiles(databasePath, parentCheckpointPath);
    await Promise.all(
      restorePoints.flatMap((path) => [
        rm(path, { force: true }),
        rm(`${path}-wal`, { force: true }),
        rm(`${path}-shm`, { force: true }),
      ]),
    );
    const auditEvent = Object.freeze({
      action: "branch.delete",
      actorId,
      tenant: branch.tenant,
      parentTenant: branch.parentTenant,
      correlationId,
      migrationHash: null,
      restorePointId: null,
      occurredAt: now(),
    });
    catalog.transaction(() => {
      insertAudit(catalog, auditEvent);
      const removed = catalog
        .query<never, [string, string, string, string, number]>(`
          DELETE FROM branch
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ? AND state = 'deleting_active'
        `)
        .run(...tenantParameters(branch.tenant));
      if (removed.changes < 1) {
        throw new BranchError("BRANCH_CONFLICT", "Branch state changed during deletion.");
      }
    })();
    await deliverAudit(options.audit, auditEvent);
    return true;
  } catch (error) {
    catalog
      .query<never, [string, string, string, string, number]>(`
        UPDATE branch SET state = 'deleting'
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND state = 'deleting_active'
      `)
      .run(...tenantParameters(branch.tenant));
    throw mapBranchError(error);
  }
}

function validateBranchLineage(parent: TenantIdentity, branch: TenantIdentity): void {
  if (
    parent.organizationId !== branch.organizationId ||
    parent.projectId !== branch.projectId ||
    sameTenant(parent, branch)
  ) {
    throw new BranchError("BRANCH_FORBIDDEN", "Preview branch lineage is invalid.");
  }
}

function validateMigrationArtifactForJournal(artifact: MigrationArtifact): void {
  try {
    const verified = createMigrationArtifact({
      id: artifact.id,
      actorId: artifact.actorId,
      idempotencyKey: artifact.idempotencyKey,
      expectedSchemaHash: artifact.expectedSchemaHash,
      sql: artifact.sql,
    });
    if (artifact.formatVersion !== verified.formatVersion || artifact.hash !== verified.hash) {
      throw new BranchError("BRANCH_VALIDATION", "Migration artifact integrity is invalid.");
    }
  } catch (error) {
    throw mapBranchError(error);
  }
}

function isMigrationApplied(storage: StorageAdapter, artifact: MigrationArtifact): boolean {
  const ledgerExists = storage.execute<{ found: number }>({
    sql: "SELECT 1 AS found FROM sqlite_master WHERE type = ? AND name = ?",
    parameters: ["table", "_mekka_migrations"],
  }).rows[0]?.found;
  if (ledgerExists !== 1) return false;
  const row = storage.execute<{ hash: string; state: string }>({
    sql: "SELECT hash, state FROM _mekka_migrations WHERE id = ?",
    parameters: [artifact.id],
  }).rows[0];
  return row?.hash === artifact.hash && row.state === "applied";
}

function scrubPreviewData(storage: StorageAdapter): void {
  const tables = buildSchemaManifest(storage).tables;
  const byName = new Map(tables.map((table) => [table.name, table]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const deletionOrder: string[] = [];

  const visit = (tableName: string): void => {
    if (visited.has(tableName)) return;
    if (visiting.has(tableName)) {
      throw new BranchError(
        "BRANCH_FORBIDDEN",
        "Preview data scrubbing cannot safely process cyclic foreign keys.",
      );
    }
    visiting.add(tableName);
    const table = byName.get(tableName);
    if (!table) {
      throw new BranchError(
        "BRANCH_INFRASTRUCTURE",
        "Schema manifest changed during preview creation.",
      );
    }
    deletionOrder.push(tableName);
    for (const foreignKey of table.foreignKeys) {
      if (byName.has(foreignKey.referencedTable)) visit(foreignKey.referencedTable);
    }
    visiting.delete(tableName);
    visited.add(tableName);
  };

  for (const table of tables) visit(table.name);
  storage.transaction((transaction) => {
    for (const tableName of deletionOrder) {
      transaction.execute({ sql: `DELETE FROM ${quoteIdentifier(tableName)}` });
    }
  });
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function validateTtl(ttlSeconds: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < minimumTtlSeconds ||
    ttlSeconds > maximumTtlSeconds
  ) {
    throw new BranchError("BRANCH_VALIDATION", "Branch TTL is outside the supported range.");
  }
}

function validateOperationIdentity(
  actorId: string,
  correlationId: string,
  idempotencyKey?: string,
): void {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(actorId) || correlationId.length < 8) {
    throw new BranchError("BRANCH_VALIDATION", "Operation identity is invalid.");
  }
  if (idempotencyKey !== undefined && !idempotencyPattern.test(idempotencyKey)) {
    throw new BranchError("BRANCH_VALIDATION", "Idempotency key is invalid.");
  }
}

function validateCredential(
  credential: BranchCredential,
  credentialId: string,
  tenant: TenantIdentity,
  expectedExpiry: number,
): void {
  if (
    credential.id !== credentialId ||
    credential.token.length < 32 ||
    credential.expiresAt !== expectedExpiry ||
    !sameTenant(credential.tenant, tenant)
  ) {
    throw new BranchError("BRANCH_INFRASTRUCTURE", "Credential issuer returned invalid data.");
  }
  const url = new URL(credential.url);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BranchError("BRANCH_INFRASTRUCTURE", "Credential issuer returned an invalid URL.");
  }
}

function approvedPath(path: string, directory: string, name: string): string {
  const root = resolve(directory);
  const resolvedPath = resolve(root, path);
  const fromRoot = relative(root, resolvedPath);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith("..\\") ||
    fromRoot.startsWith("../")
  ) {
    throw new BranchError("BRANCH_VALIDATION", `${name} path escaped its approved directory.`);
  }
  return resolvedPath;
}

function scopedPath(directory: string, tenant: TenantIdentity, filename: string): string {
  return approvedPath(
    join(
      tenant.organizationId,
      tenant.projectId,
      tenant.environmentId,
      tenant.branchId,
      String(tenant.generation),
      filename,
    ),
    directory,
    "Branch resource",
  );
}

function tenantParameters(tenant: TenantIdentity): [string, string, string, string, number] {
  return [
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ];
}

function sameTenant(left: TenantIdentity, right: TenantIdentity): boolean {
  return (
    JSON.stringify(serializeTenantIdentity(left)) === JSON.stringify(serializeTenantIdentity(right))
  );
}

function parseBackup(value: string): BackupArtifact {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new BranchError("BRANCH_INFRASTRUCTURE", "Branch checkpoint metadata is invalid.");
  }
  const backup = parsed as Record<string, unknown>;
  if (
    backup.formatVersion !== 1 ||
    typeof backup.id !== "string" ||
    typeof backup.sourceSchemaHash !== "string" ||
    typeof backup.schemaFingerprint !== "string" ||
    typeof backup.checkpointPath !== "string"
  ) {
    throw new BranchError("BRANCH_INFRASTRUCTURE", "Branch checkpoint metadata is invalid.");
  }
  return Object.freeze({
    formatVersion: 1,
    id: backup.id,
    sourceSchemaHash: backup.sourceSchemaHash,
    schemaFingerprint: backup.schemaFingerprint,
    checkpointPath: backup.checkpointPath,
  });
}

function readMigrationArtifact(value: unknown): MigrationArtifact {
  if (typeof value !== "object" || value === null) {
    throw new BranchError("BRANCH_VALIDATION", "Migration artifact is required.");
  }
  const artifact = value as Record<string, unknown>;
  if (
    artifact.formatVersion !== 1 ||
    typeof artifact.id !== "string" ||
    typeof artifact.actorId !== "string" ||
    typeof artifact.idempotencyKey !== "string" ||
    typeof artifact.expectedSchemaHash !== "string" ||
    typeof artifact.sql !== "string" ||
    typeof artifact.hash !== "string"
  ) {
    throw new BranchError("BRANCH_VALIDATION", "Migration artifact is invalid.");
  }
  return Object.freeze({
    formatVersion: 1,
    id: artifact.id,
    actorId: artifact.actorId,
    idempotencyKey: artifact.idempotencyKey,
    expectedSchemaHash: artifact.expectedSchemaHash,
    sql: artifact.sql,
    hash: artifact.hash,
  });
}

function readTenantIdentity(value: unknown): TenantIdentity {
  const record = readRecord(value, "tenant");
  return parseTenantIdentity({
    organizationId: record.organizationId,
    projectId: record.projectId,
    environmentId: record.environmentId,
    branchId: record.branchId,
    generation: record.generation,
  });
}

function requireCapability(context: TenantContext, action: string, timestamp: number): void {
  if (!hasCapability(context, action, timestamp)) throw new ProtocolError("forbidden");
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ProtocolError("validation");
  }
  return readRecord(value, "body");
}

function readRecord(value: unknown, _name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError("validation");
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new ProtocolError("validation");
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value)) throw new ProtocolError("validation");
  return value as number;
}

function readPositiveInteger(value: string | null): number {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) throw new ProtocolError("validation");
  return Number(value);
}

function readRequiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ProtocolError("validation");
  return value;
}

function readSyntheticUser(value: unknown): Readonly<{ id: string; email: string; name: string }> {
  const record = readRecord(value, "synthetic user");
  return Object.freeze({
    id: readString(record, "id"),
    email: readString(record, "email"),
    name: readString(record, "name"),
  });
}

function publicBranch(branch: BranchRecord) {
  return Object.freeze({
    formatVersion: branch.formatVersion,
    tenant: branch.tenant,
    parentTenant: branch.parentTenant,
    state: branch.state,
    parentCheckpointId: branch.parentCheckpoint.id,
    parentSchemaHash: branch.parentSchemaHash,
    branchSchemaHash: branch.branchSchemaHash,
    createdAt: branch.createdAt,
    expiresAt: branch.expiresAt,
    promotedAt: branch.promotedAt,
  });
}

function jsonResponse(
  value: unknown,
  status = 200,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...additionalHeaders },
  });
}

function toProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  if (error instanceof BranchError) {
    if (error.code === "BRANCH_VALIDATION") return new ProtocolError("validation");
    if (error.code === "BRANCH_FORBIDDEN") return new ProtocolError("forbidden");
    if (error.code === "BRANCH_NOT_FOUND") return new ProtocolError("validation");
    if (error.code === "BRANCH_CONFLICT") return new ProtocolError("conflict");
  }
  return new ProtocolError("infrastructure");
}

function mapBranchError(error: unknown): BranchError {
  if (error instanceof BranchError) return error;
  if (error instanceof MigrationError) {
    if (error.code === "MIGRATION_CONFLICT") {
      return new BranchError("BRANCH_CONFLICT", error.message);
    }
    if (error.code === "MIGRATION_VALIDATION" || error.code === "MIGRATION_FORBIDDEN") {
      return new BranchError("BRANCH_VALIDATION", error.message);
    }
  }
  return new BranchError("BRANCH_INFRASTRUCTURE", "Branch lifecycle operation failed.");
}

function insertAudit(database: Database, event: BranchAuditEvent): void {
  database
    .query<never, [string, string, string, string, number, string, string, string]>(`
      INSERT INTO branch_audit (
        organization_id, project_id, environment_id, branch_id, generation,
        correlation_id, action, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `)
    .run(
      ...tenantParameters(event.tenant),
      event.correlationId,
      event.action,
      JSON.stringify(event),
    );
}

async function deliverAudit(sink: BranchAuditSink, event: BranchAuditEvent): Promise<void> {
  await Promise.resolve(sink.record(Object.freeze({ ...event }))).catch(() => {});
}

export function branchCredentialDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
