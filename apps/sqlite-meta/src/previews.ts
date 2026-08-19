import type { EngineError, EngineExecutor, EngineValue } from "@mekka/engine-core";
import type { TenantContext, TenantIdentity } from "@mekka/protocol";
import { buildSchemaManifestAsync } from "@mekka/schema-manifest";
import { buildBranchDatabaseName, type TursoBranchAdapter } from "@mekka/turso-branch";
import type { SqliteMetaAuditEvent, SqliteMetaProject } from "./app";
import { MetaError } from "./errors";

/**
 * Provider-backed preview lifecycle for libSQL.
 *
 * A preview is a fork of the primary database at the branch provider (Turso). The
 * provider resource is uniquely identified by a database name derived from the full
 * tenant identity, so retries of create/delete are naturally idempotent and
 * cross-tenant collisions are impossible by construction.
 *
 * Promotion deliberately does not merge divergent schemas or rows: it confirms that
 * the primary has not moved since the preview was created (schema parity) and records
 * the promotion under the caller's idempotency key. A diverged primary is a typed
 * conflict; the preview must be recreated. This is the safe thin-promotion contract;
 * there is no schema-diff engine in this product yet.
 *
 * The provider API token lives in the adapter (server-side env) and the database
 * auth token is stored in the tenant-scoped catalog row only. Neither is ever
 * serialized into API responses, events or error messages.
 */

export type PreviewState = "provisioning" | "ready" | "failed" | "deleting";

export type PreviewRecordDto = Readonly<{
  name: string;
  state: PreviewState;
  resourceId: string;
  hostname: string | null;
  createdAt: number;
  updatedAt: number;
  promotedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  schemaHash: string;
}>;

export type PromotionResultDto = Readonly<{
  name: string;
  state: PreviewState;
  promotedAt: number;
  schemaHash: string;
}>;

export type SqliteMetaPreviewDependencies = Readonly<{
  /** `null` when the provider is not configured; every preview route reports `unsupported`. */
  adapter: TursoBranchAdapter | null;
  now?: () => number;
}>;

export type PreviewRecordAudit = (
  event: Extract<
    SqliteMetaAuditEvent["action"],
    "preview_create" | "preview_delete" | "preview_status" | "preview_promote"
  >,
) => void;

type CatalogRow = Readonly<{
  name: string;
  resourceId: string;
  hostname: string | null;
  group: string;
  state: PreviewState;
  previewSchemaHash: string;
  primarySchemaHash: string;
  errorCode: string | null;
  errorMessage: string | null;
  token: string;
  tokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
  promotedAt: number | null;
  promotionId: string | null;
}>;

const previewNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const defaultTokenExpirationSeconds = 7 * 24 * 60 * 60;

export function readPreviewName(value: unknown): string {
  if (typeof value !== "string" || !previewNamePattern.test(value)) {
    throw new MetaError(
      "validation",
      "Preview name must be lowercase alphanumeric with dashes (max 64 characters).",
    );
  }
  return value;
}

export async function listPreviews(
  dependencies: SqliteMetaPreviewDependencies,
  project: SqliteMetaProject,
): Promise<readonly PreviewRecordDto[]> {
  requireAdapter(dependencies);
  await initializePreviewCatalog(project.engine);
  const rows = (
    await project.engine.execute<CatalogRow>({
      sql: `SELECT name, resource_id AS resourceId, hostname, db_group AS "group", state,
        preview_schema_hash AS previewSchemaHash, primary_schema_hash AS primarySchemaHash,
        error_code AS errorCode, error_message AS errorMessage, token, token_expires_at AS tokenExpiresAt,
        created_at AS createdAt, updated_at AS updatedAt, promoted_at AS promotedAt,
        promotion_id AS promotionId
      FROM _mekka_preview_catalog
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ?
      ORDER BY created_at ASC, name ASC LIMIT 200`,
      parameters: tenantParameters(project.tenant),
    })
  ).rows;
  return Object.freeze(rows.map(catalogRowDto));
}

export async function createPreview(
  dependencies: SqliteMetaPreviewDependencies,
  context: TenantContext,
  project: SqliteMetaProject,
  audit: PreviewRecordAudit,
): Promise<PreviewRecordDto> {
  const adapter = requireAdapter(dependencies);
  const now = dependencies.now ?? Date.now;
  const name = buildBranchDatabaseName(context.tenant);
  await initializePreviewCatalog(project.engine);
  const existing = await readCatalogRow(project, name);
  if (existing !== null) {
    if (existing.state === "deleting") {
      throw new MetaError(
        "conflict",
        "The preview is being deleted; wait for the delete to complete before recreating it.",
      );
    }
    if (existing.state === "ready" || existing.state === "provisioning") {
      return catalogRowDto(existing);
    }
  }
  const schemaHash = await currentSchemaHash(project);
  const createdAt = existing?.createdAt ?? now();
  await writeCatalogRow(project, provisioningCatalogRow(name, schemaHash, now(), createdAt));
  try {
    const created = await adapter.createBranch(
      { name, tokenExpirationSeconds: defaultTokenExpirationSeconds },
      { operationId: context.correlationId },
    );
    await writeCatalogRow(
      project,
      Object.freeze({
        ...provisioningCatalogRow(name, schemaHash, now(), createdAt),
        resourceId: created.database.resourceId,
        hostname: created.database.hostname,
        group: created.database.group,
        state: "ready" as const,
        token: created.token,
        tokenExpiresAt: created.tokenExpiresAt,
        updatedAt: now(),
      }),
    );
    audit("preview_create");
    return readPreviewDto(project, name);
  } catch (error) {
    const mapped = toPreviewError(error);
    await writeCatalogRow(
      project,
      Object.freeze({
        ...provisioningCatalogRow(name, schemaHash, now(), createdAt),
        resourceId: existing?.resourceId ?? "",
        hostname: existing?.hostname ?? null,
        group: existing?.group ?? "",
        state: "failed" as const,
        errorCode: engineErrorCode(error),
        errorMessage: mapped.message,
        token: existing?.token ?? "",
        tokenExpiresAt: existing?.tokenExpiresAt ?? 0,
        updatedAt: now(),
      }),
    );
    return readPreviewDto(project, name);
  }
}

export async function getPreview(
  dependencies: SqliteMetaPreviewDependencies,
  project: SqliteMetaProject,
  name: string,
): Promise<PreviewRecordDto> {
  requireAdapter(dependencies);
  await initializePreviewCatalog(project.engine);
  return readPreviewDto(project, name);
}

export async function refreshPreviewStatus(
  dependencies: SqliteMetaPreviewDependencies,
  project: SqliteMetaProject,
  name: string,
  audit: PreviewRecordAudit,
): Promise<PreviewRecordDto> {
  const adapter = requireAdapter(dependencies);
  const now = dependencies.now ?? Date.now;
  await initializePreviewCatalog(project.engine);
  const existing = await readCatalogRow(project, name);
  if (existing === null) throw new MetaError("not_found", "The preview does not exist.");
  if (existing.state === "deleting") return catalogRowDto(existing);
  const status = await adapter.getBranchStatus(name);
  if (status.exists && status.database !== null) {
    await writeCatalogRow(
      project,
      Object.freeze({
        ...existing,
        resourceId: status.database.resourceId,
        hostname: status.database.hostname,
        group: status.database.group,
        state: "ready" as const,
        errorCode: null,
        errorMessage: null,
        updatedAt: now(),
      }),
    );
    audit("preview_status");
    return readPreviewDto(project, name);
  }
  await writeCatalogRow(
    project,
    Object.freeze({
      ...existing,
      state: "failed" as const,
      errorCode: "ENGINE_NOT_FOUND",
      errorMessage: "The provider resource no longer exists; delete the preview.",
      updatedAt: now(),
    }),
  );
  audit("preview_status");
  return readPreviewDto(project, name);
}

export async function deletePreview(
  dependencies: SqliteMetaPreviewDependencies,
  project: SqliteMetaProject,
  name: string,
  audit: PreviewRecordAudit,
): Promise<PreviewRecordDto> {
  const adapter = requireAdapter(dependencies);
  const now = dependencies.now ?? Date.now;
  await initializePreviewCatalog(project.engine);
  const existing = await readCatalogRow(project, name);
  if (existing === null) throw new MetaError("not_found", "The preview does not exist.");
  if (existing.state === "deleting") return catalogRowDto(existing);
  await writeCatalogRow(
    project,
    Object.freeze({ ...existing, state: "deleting" as const, updatedAt: now() }),
  );
  await adapter.deleteBranch(name);
  audit("preview_delete");
  return readPreviewDto(project, name);
}

export async function promotePreview(
  dependencies: SqliteMetaPreviewDependencies,
  project: SqliteMetaProject,
  name: string,
  confirmed: boolean,
  idempotencyKey: string,
  audit: PreviewRecordAudit,
): Promise<PromotionResultDto> {
  requireAdapter(dependencies);
  const now = dependencies.now ?? Date.now;
  await initializePreviewCatalog(project.engine);
  const existing = await readCatalogRow(project, name);
  if (existing === null) throw new MetaError("not_found", "The preview does not exist.");
  if (existing.state !== "ready") {
    throw new MetaError("conflict", "Only ready previews can be promoted.");
  }
  if (confirmed !== true) {
    throw new MetaError("validation", "Promotion requires explicit confirmation.");
  }
  if (existing.promotionId === idempotencyKey) {
    if (existing.promotedAt === null) {
      throw new MetaError("infrastructure", "The promotion record is invalid.");
    }
    return promotionResult(existing.name, existing.promotedAt, existing.primarySchemaHash);
  }
  if (existing.promotedAt !== null) {
    throw new MetaError("conflict", "The preview was already promoted.");
  }
  const primaryHash = await currentSchemaHash(project);
  if (existing.primarySchemaHash !== primaryHash) {
    throw new MetaError(
      "conflict",
      "The primary schema diverged since the preview was created; recreate the preview and retry.",
    );
  }
  const promotedAt = now();
  await writeCatalogRow(
    project,
    Object.freeze({
      ...existing,
      promotedAt,
      promotionId: idempotencyKey,
      updatedAt: promotedAt,
    }),
  );
  audit("preview_promote");
  return promotionResult(existing.name, promotedAt, existing.primarySchemaHash);
}

function promotionResult(name: string, promotedAt: number, schemaHash: string): PromotionResultDto {
  return Object.freeze({ name, state: "ready" as const, promotedAt, schemaHash });
}

function requireAdapter(dependencies: SqliteMetaPreviewDependencies): TursoBranchAdapter {
  if (dependencies.adapter === null) {
    throw new MetaError(
      "unsupported",
      "Provider-backed previews are not configured for this deployment.",
    );
  }
  return dependencies.adapter;
}

async function currentSchemaHash(project: SqliteMetaProject): Promise<string> {
  return (await (project.schemaCache?.get() ?? buildSchemaManifestAsync(project.engine))).hash;
}

async function initializePreviewCatalog(storage: EngineExecutor): Promise<void> {
  await storage.execute({
    sql: `CREATE TABLE IF NOT EXISTS _mekka_preview_catalog (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, generation INTEGER NOT NULL,
      name TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      hostname TEXT,
      db_group TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'failed', 'deleting')),
      preview_schema_hash TEXT NOT NULL,
      primary_schema_hash TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      token TEXT NOT NULL,
      token_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      promoted_at INTEGER,
      promotion_id TEXT,
      PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation, name)
    ) STRICT`,
  });
}

function provisioningCatalogRow(
  name: string,
  schemaHash: string,
  now: number,
  createdAt: number,
): CatalogRow {
  return Object.freeze({
    name,
    resourceId: "",
    hostname: null,
    group: "",
    state: "provisioning" as const,
    previewSchemaHash: schemaHash,
    primarySchemaHash: schemaHash,
    errorCode: null,
    errorMessage: null,
    token: "",
    tokenExpiresAt: 0,
    createdAt,
    updatedAt: now,
    promotedAt: null,
    promotionId: null,
  });
}

async function writeCatalogRow(project: SqliteMetaProject, row: CatalogRow): Promise<void> {
  await project.engine.execute({
    sql: `INSERT INTO _mekka_preview_catalog (
        organization_id, project_id, environment_id, branch_id, generation,
        name, resource_id, hostname, db_group, state,
        preview_schema_hash, primary_schema_hash, error_code, error_message,
        token, token_expires_at, created_at, updated_at, promoted_at, promotion_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, project_id, environment_id, branch_id, generation, name)
      DO UPDATE SET
        resource_id = excluded.resource_id,
        hostname = excluded.hostname,
        db_group = excluded.db_group,
        state = excluded.state,
        preview_schema_hash = excluded.preview_schema_hash,
        primary_schema_hash = excluded.primary_schema_hash,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        token = excluded.token,
        token_expires_at = excluded.token_expires_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        promoted_at = excluded.promoted_at,
        promotion_id = excluded.promotion_id`,
    parameters: [
      ...tenantParameters(project.tenant),
      row.name,
      row.resourceId,
      row.hostname,
      row.group,
      row.state,
      row.previewSchemaHash,
      row.primarySchemaHash,
      row.errorCode,
      row.errorMessage,
      row.token,
      row.tokenExpiresAt,
      row.createdAt,
      row.updatedAt,
      row.promotedAt,
      row.promotionId,
    ],
  });
}

async function readCatalogRow(
  project: SqliteMetaProject,
  name: string,
): Promise<CatalogRow | null> {
  const row = (
    await project.engine.execute<CatalogRow>({
      sql: `SELECT name, resource_id AS resourceId, hostname, db_group AS "group", state,
        preview_schema_hash AS previewSchemaHash, primary_schema_hash AS primarySchemaHash,
        error_code AS errorCode, error_message AS errorMessage, token, token_expires_at AS tokenExpiresAt,
        created_at AS createdAt, updated_at AS updatedAt, promoted_at AS promotedAt,
        promotion_id AS promotionId
      FROM _mekka_preview_catalog
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND name = ?`,
      parameters: [...tenantParameters(project.tenant), name],
    })
  ).rows[0];
  return row === undefined ? null : Object.freeze(row);
}

async function readPreviewDto(project: SqliteMetaProject, name: string): Promise<PreviewRecordDto> {
  const row = await readCatalogRow(project, name);
  if (row === null) throw new MetaError("not_found", "The preview does not exist.");
  return catalogRowDto(row);
}

/** The DTO never contains the database token; it is a server-side secret. */
function catalogRowDto(row: CatalogRow): PreviewRecordDto {
  return Object.freeze({
    name: row.name,
    state: row.state,
    resourceId: row.resourceId,
    hostname: row.hostname,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    promotedAt: row.promotedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    schemaHash: row.primarySchemaHash,
  });
}

function engineErrorCode(error: unknown): string {
  const code =
    error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
  return /^[A-Z0-9_]{1,64}$/.test(code) ? code : "ENGINE_FAILED";
}

/**
 * Maps provider errors to typed client-facing errors. Messages are generic: they
 * never include provider URLs, tokens, database names or response payloads.
 */
function toPreviewError(error: unknown): MetaError {
  if (error instanceof MetaError) {
    return error;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    isEngineErrorCode((error as { code: unknown }).code)
  ) {
    const engineError = error as EngineError;
    switch (engineError.code) {
      case "ENGINE_AUTH":
        return new MetaError(
          "infrastructure",
          "The branch provider rejected the server-side credentials.",
        );
      case "ENGINE_RATE_LIMITED":
        return new MetaError(
          "quota",
          "The branch provider is rate limiting requests; retry later.",
        );
      case "ENGINE_TIMEOUT":
        return new MetaError("infrastructure", "The branch provider request timed out.");
      case "ENGINE_UNAVAILABLE":
        return new MetaError("infrastructure", "The branch provider is temporarily unavailable.");
      case "ENGINE_CONFLICT":
        return new MetaError("conflict", "The branch provider reported a conflicting state.");
      case "ENGINE_NOT_FOUND":
        return new MetaError("not_found", "The branch provider resource does not exist.");
      default:
        return new MetaError("infrastructure", "The branch provider operation failed.");
    }
  }
  return new MetaError("infrastructure", "The branch provider operation failed.");
}

function isEngineErrorCode(value: unknown): value is EngineError["code"] {
  return (
    typeof value === "string" && /^ENGINE_[A-Z_]+$/.test(value) && value !== "ENGINE_UNSUPPORTED"
  );
}

function tenantParameters(tenant: TenantIdentity): readonly EngineValue[] {
  return Object.freeze([
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ]);
}
