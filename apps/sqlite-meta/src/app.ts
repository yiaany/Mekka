import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Engine, EngineExecutor, EngineValue } from "@mekka/engine-core";
import {
  type BackupArtifact,
  createCheckpoint,
  createMigrationArtifact,
  discardCheckpoint,
  type MigrationArtifact,
} from "@mekka/migration-engine";
import {
  createErrorEnvelope,
  hasCapability,
  parseTenantIdentityFromHeaders,
  resolveCorrelationId,
  type TenantContext,
  type TenantIdentity,
} from "@mekka/protocol";
import {
  buildSchemaManifest,
  buildSchemaManifestAsync,
  type AsyncSchemaManifestCache,
  isReservedSchemaIdentifier,
  type SchemaManifest,
  type SchemaTable,
} from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core/sqlite";
import { Elysia } from "elysia";
import type { EngineStatus } from "./engine";
import { MetaError, toMetaError } from "./errors";
import {
  createPreview,
  deletePreview,
  getPreview,
  listPreviews,
  type PreviewRecordAudit,
  promotePreview,
  readPreviewName,
  refreshPreviewStatus,
  type SqliteMetaPreviewDependencies,
} from "./previews";

export type SqliteMetaColumn = Readonly<{
  name: string;
  type: string;
  nullable: boolean;
  primaryKeyPosition: number;
  defaultValue: string | null;
}>;

export type SqliteMetaIndex = Readonly<{
  name: string;
  table: string;
  unique: boolean;
  columns: readonly string[];
}>;

export type SqliteMetaTable = Readonly<{
  name: string;
  columns: readonly SqliteMetaColumn[];
  primaryKey: readonly string[];
  indexes: readonly SqliteMetaIndex[];
}>;

type MutationResult<T> = Readonly<{
  resource: T;
  migrationSql: string;
  checkpointId: string | null;
}>;

export type SqliteMetaSchemaHealth = Readonly<{
  status: "ok";
  formatVersion: number;
  schemaVersion: number;
  schemaHash: string;
}>;

export type SqliteMetaProject = Readonly<{
  tenant: TenantIdentity;
  engine: Engine;
  localStorage?: StorageAdapter;
  schemaCache?: AsyncSchemaManifestCache;
}>;

export type SqliteMetaAuditEvent = Readonly<{
  action:
    | "create_table"
    | "rename_table"
    | "delete_table"
    | "add_column"
    | "rename_column"
    | "create_index"
    | "create_row"
    | "update_row"
    | "delete_row"
    | "run_sql_read"
    | "run_sql_write"
    | "preview_create"
    | "preview_delete"
    | "preview_status"
    | "preview_promote";
  actorId: string;
  migrationHash?: string;
  checkpointId?: string | null;
  statementHash?: string;
  rowCount?: number;
}>;

export type SqliteMetaDependencies = Readonly<{
  authenticate(request: Request): Promise<TenantContext> | TenantContext;
  resolveProject(context: TenantContext): Promise<SqliteMetaProject> | SqliteMetaProject;
  recordAudit(event: SqliteMetaAuditEvent): void;
  checkpointDirectory: string;
  engine?: SqliteMetaEngineDependencies;
  previews?: SqliteMetaPreviewDependencies;
  now?: () => number;
}>;

export type SqliteMetaEngineDependencies = Readonly<{
  status(): EngineStatus;
  testConnection(): Promise<EngineStatus>;
}>;

type ColumnInput = Readonly<{
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
}>;

type RowValue = string | number | null;
type RowInput = Readonly<Record<string, RowValue>>;
type SqlOperation = "read" | "write";
type RowMutationResponse = Readonly<{ changes: number; idempotencyKey: string }>;
type SqlWriteResponse = Readonly<{
  rows: readonly Readonly<Record<string, EngineValue>>[];
  changes: number;
  idempotencyKey: string;
}>;
type IdempotencyLedgerRow = Readonly<{ request_hash: string; response_payload: string }>;
type AuditOutboxRow = Readonly<{ id: number; payload: string }>;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const schemaHashPattern = /^[a-f0-9]{64}$/;
const allowedTypes = new Set(["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"]);
const maxRowPageSize = 200;
const maxSqlLength = 8_192;
const maxRequestBodyBytes = 64 * 1024;
const maxResultBodyBytes = 1024 * 1024;

export function createSqliteMetaApp(dependencies: SqliteMetaDependencies) {
  const now = dependencies.now ?? Date.now;
  return new Elysia({ name: "sqlite-meta" })
    .get("/tables", async ({ request }) =>
      handle(request, dependencies, now, "schema:read", async (_context, project) =>
        tablesDto(await manifest(project)),
      ),
    )
    .get("/tables/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "schema:read", async (_context, project) =>
        tableDto(requireTable(await manifest(project), readRouteIdentifier(params.table, "table"))),
      ),
    )
    .get("/schema/health", async ({ request }) =>
      handle(request, dependencies, now, "schema:read", async (_context, project) => {
        const schema = await manifest(project);
        return Object.freeze({
          status: "ok" as const,
          formatVersion: schema.formatVersion,
          schemaVersion: schema.schemaVersion,
          schemaHash: schema.hash,
        });
      }),
    )
    .get("/rows/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "data:read", async (_context, project) => {
        const table = readRouteIdentifier(params.table, "table");
        const definition = requireTable(await manifest(project), table);
        const search = new URL(request.url).searchParams;
        const limit = readBoundedQueryInteger(search.get("limit"), 50, 1, maxRowPageSize);
        const offset = readBoundedQueryInteger(search.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
        const filterColumn = search.get("filter_column");
        const filterValue = search.get("filter_value");
        if ((filterColumn === null) !== (filterValue === null)) {
          throw new MetaError("validation", "Filter column and value must be supplied together.");
        }
        const filter =
          filterColumn === null
            ? undefined
            : {
                column: requireExposedColumn(definition, filterColumn),
                value: filterValue as string,
              };
        const where =
          filter === undefined ? "" : ` WHERE ${quote(filter.column)} LIKE ? ESCAPE '\\'`;
        const parameters: EngineValue[] =
          filter === undefined ? [] : [`%${escapeLike(filter.value)}%`];
        const totalCount = (
          await project.engine.execute<{ count: number }>({
            sql: `SELECT COUNT(*) AS count FROM ${quote(table)}${where}`,
            parameters,
          })
        ).rows[0]?.count;
        const rows = (
          await project.engine.execute<Record<string, EngineValue>>({
            sql: `SELECT * FROM ${quote(table)}${where} LIMIT ? OFFSET ?`,
            parameters: [...parameters, limit, offset],
          })
        ).rows;
        return Object.freeze({
          rows: Object.freeze(rows.map(rowDto)),
          totalCount: typeof totalCount === "number" ? totalCount : 0,
          limit,
          offset,
        });
      }),
    )
    .post("/rows/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "data:write", async (context, project) => {
        const table = readRouteIdentifier(params.table, "table");
        const definition = requireTable(await manifest(project), table);
        const values = readRowValues(await readBody(request), definition, true);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const columns = Object.keys(values);
        return mutateRowIdempotently(
          project,
          context,
          dependencies,
          idempotencyKey,
          { operation: "create_row", table, values },
          `INSERT ${table}`,
          async (transaction) =>
            (
              await transaction.execute({
                sql: `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
                parameters: columns.map((column) => values[column] as EngineValue),
              })
            ).changes,
        );
      }),
    )
    .patch("/rows/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "data:write", async (context, project) => {
        const table = readRouteIdentifier(params.table, "table");
        const definition = requireTable(await manifest(project), table);
        const body = await readBody(request);
        const key = readRowKey(body, definition);
        const values = readRowValues(readRecord(body.values, "values"), definition, false);
        const idempotencyKey = readIdempotencyKey(request.headers);
        const columns = Object.keys(values);
        if (columns.length === 0)
          throw new MetaError("validation", "At least one row value is required.");
        return mutateRowIdempotently(
          project,
          context,
          dependencies,
          idempotencyKey,
          { operation: "update_row", table, key, values },
          `UPDATE ${table}`,
          async (transaction) =>
            (
              await transaction.execute({
                sql: `UPDATE ${quote(table)} SET ${columns.map((column) => `${quote(column)} = ?`).join(", ")} WHERE ${quote(key.column)} IS ?`,
                parameters: [...columns.map((column) => values[column] as EngineValue), key.value],
              })
            ).changes,
        );
      }),
    )
    .delete("/rows/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "data:write", async (context, project) => {
        const table = readRouteIdentifier(params.table, "table");
        const definition = requireTable(await manifest(project), table);
        const key = readDeleteRowKey(request, definition);
        const idempotencyKey = readIdempotencyKey(request.headers);
        return mutateRowIdempotently(
          project,
          context,
          dependencies,
          idempotencyKey,
          { operation: "delete_row", table, key },
          `DELETE ${table}`,
          async (transaction) =>
            (
              await transaction.execute({
                sql: `DELETE FROM ${quote(table)} WHERE ${quote(key.column)} IS ?`,
                parameters: [key.value],
              })
            ).changes,
        );
      }),
    )
    .post("/sql", async ({ request }) => handleSql(request, dependencies, now))
    .post("/tables", async ({ request }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const body = await readBody(request);
        const name = readIdentifier(body, "name");
        const columns = readColumns(body);
        const expectedSchemaHash = readSchemaHash(body);
        const sql = createTableSql(name, columns);
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "create_table",
          name,
          expectedSchemaHash,
          sql,
          false,
        );
      }),
    )
    .patch("/tables/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const body = await readBody(request);
        const table = readRouteIdentifier(params.table, "table");
        const name = readIdentifier(body, "name");
        const expectedSchemaHash = readSchemaHash(body);
        requireTable(await manifest(project), table);
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "rename_table",
          table,
          expectedSchemaHash,
          `ALTER TABLE ${quote(table)} RENAME TO ${quote(name)}`,
          false,
        );
      }),
    )
    .delete("/tables/:table", async ({ request, params }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const table = readRouteIdentifier(params.table, "table");
        const expectedSchemaHash = readExpectedSchemaQuery(request);
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "delete_table",
          table,
          expectedSchemaHash,
          `DROP TABLE ${quote(table)}`,
          true,
        );
      }),
    )
    .get("/columns", async ({ request }) =>
      handle(request, dependencies, now, "schema:read", async (_context, project) => {
        const table = new URL(request.url).searchParams.get("table");
        const tables =
          table === null
            ? (await manifest(project)).tables
            : [requireTable(await manifest(project), table)];
        return tables.flatMap((candidate) =>
          tableDto(candidate).columns.map((column) => ({ table: candidate.name, ...column })),
        );
      }),
    )
    .post("/columns", async ({ request }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const body = await readBody(request);
        const table = readIdentifier(body, "table");
        const column = readColumn(body);
        const expectedSchemaHash = readSchemaHash(body);
        requireTable(await manifest(project), table);
        if (column.primaryKey === true || column.nullable === false) {
          throw new MetaError(
            "unsupported",
            "Adding primary key or NOT NULL columns is not supported.",
          );
        }
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "add_column",
          table,
          expectedSchemaHash,
          `ALTER TABLE ${quote(table)} ADD COLUMN ${columnSql(column)}`,
          false,
        );
      }),
    )
    .patch("/columns/:table/:column", async ({ request, params }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const body = await readBody(request);
        const table = readRouteIdentifier(params.table, "table");
        const column = readRouteIdentifier(params.column, "column");
        const name = readIdentifier(body, "name");
        const expectedSchemaHash = readSchemaHash(body);
        const current = requireTable(await manifest(project), table);
        if (
          !current.columns.some(
            (candidate) => candidate.name === column && candidate.hidden === "none",
          )
        ) {
          throw new MetaError("validation", "Column is not exposed by the schema.");
        }
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "rename_column",
          table,
          expectedSchemaHash,
          `ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(column)} TO ${quote(name)}`,
          false,
        );
      }),
    )
    .get("/indexes", async ({ request }) =>
      handle(request, dependencies, now, "schema:read", async (_context, project) => {
        const table = new URL(request.url).searchParams.get("table");
        const tables =
          table === null
            ? (await manifest(project)).tables
            : [requireTable(await manifest(project), table)];
        return tables.flatMap((candidate) => tableDto(candidate).indexes);
      }),
    )
    .post("/indexes", async ({ request }) =>
      handle(request, dependencies, now, "schema:manage", async (context, project) => {
        const body = await readBody(request);
        const table = readIdentifier(body, "table");
        const name = readIdentifier(body, "name");
        const columns = readIdentifierArray(body, "columns");
        const unique = readOptionalBoolean(body, "unique") ?? false;
        const expectedSchemaHash = readSchemaHash(body);
        const current = requireTable(await manifest(project), table);
        for (const column of columns) {
          if (
            !current.columns.some(
              (candidate) => candidate.name === column && candidate.hidden === "none",
            )
          ) {
            throw new MetaError("validation", "Index column is not exposed by the schema.");
          }
        }
        return mutate(
          context,
          project,
          dependencies,
          request.headers,
          "create_index",
          table,
          expectedSchemaHash,
          `CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(table)} (${columns.map(quote).join(", ")})`,
          false,
        );
      }),
    )
    .get("/previews", async ({ request }) =>
      handle(request, dependencies, now, "preview:manage", (_context, project) =>
        listPreviews(requirePreviews(dependencies, now), project),
      ),
    )
    .post("/previews", async ({ request }) =>
      handle(request, dependencies, now, "preview:manage", async (context, project) => {
        const previews = requirePreviews(dependencies, now);
        const audit = previewAudit(dependencies, context);
        return createPreview(previews, context, project, audit);
      }),
    )
    .get("/previews/:name", async ({ request, params }) =>
      handle(request, dependencies, now, "preview:manage", (_context, project) =>
        getPreview(requirePreviews(dependencies, now), project, readPreviewName(params.name)),
      ),
    )
    .get("/previews/:name/status", async ({ request, params }) =>
      handle(request, dependencies, now, "preview:manage", async (_context, project) => {
        const previews = requirePreviews(dependencies, now);
        const audit = previewAudit(dependencies, _context);
        return refreshPreviewStatus(previews, project, readPreviewName(params.name), audit);
      }),
    )
    .delete("/previews/:name", async ({ request, params }) =>
      handle(request, dependencies, now, "preview:manage", async (context, project) => {
        const previews = requirePreviews(dependencies, now);
        const audit = previewAudit(dependencies, context);
        return deletePreview(previews, project, readPreviewName(params.name), audit);
      }),
    )
    .post("/previews/:name/promote", async ({ request, params }) =>
      handle(request, dependencies, now, "preview:manage", async (context, project) => {
        const previews = requirePreviews(dependencies, now);
        const audit = previewAudit(dependencies, context);
        const body = await readBody(request);
        return promotePreview(
          previews,
          project,
          readPreviewName(params.name),
          body.confirmed === true,
          readIdempotencyKey(request.headers),
          audit,
        );
      }),
    )
    .get("/engine/status", async ({ request }) => handleEngine(request, dependencies, "status"))
    .post("/engine/test-connection", async ({ request }) =>
      handleEngine(request, dependencies, "testConnection"),
    );
}

async function handle<T>(
  request: Request,
  dependencies: SqliteMetaDependencies,
  now: () => number,
  requiredCapability: string,
  operation: (context: TenantContext, project: SqliteMetaProject) => Promise<T> | T,
): Promise<Response> {
  try {
    const headerTenant = parseTenantIdentityFromHeaders(request.headers);
    const context = await dependencies.authenticate(request);
    if (
      !sameTenant(headerTenant, context.tenant) ||
      !hasRequiredCapability(context, requiredCapability, now())
    ) {
      throw new MetaError("forbidden", "Schema management is not permitted.");
    }
    const project = await dependencies.resolveProject(context);
    if (!sameTenant(project.tenant, context.tenant)) {
      throw new MetaError("forbidden", "Resolved project does not match request tenant.");
    }
    return jsonResponse(await operation(context, project), {
      headers: { "x-correlation-id": context.correlationId },
    });
  } catch (error) {
    const metaError = toMetaError(error);
    const correlationId = resolveCorrelationId(request.headers);
    return Response.json(createErrorEnvelope(metaError.code, correlationId), {
      status: metaError.status,
      headers: { "x-correlation-id": correlationId },
    });
  }
}

function requirePreviews(
  dependencies: SqliteMetaDependencies,
  now: () => number,
): SqliteMetaPreviewDependencies {
  if (dependencies.previews === undefined) {
    throw new MetaError(
      "unsupported",
      "Provider-backed previews are not configured for this deployment.",
    );
  }
  return Object.freeze({ adapter: dependencies.previews.adapter, now });
}

function previewAudit(
  dependencies: SqliteMetaDependencies,
  context: TenantContext,
): PreviewRecordAudit {
  return (action) => dependencies.recordAudit({ action, actorId: context.actor.id });
}

async function handleEngine(
  request: Request,
  dependencies: SqliteMetaDependencies,
  operation: "status" | "testConnection",
): Promise<Response> {
  try {
    if (dependencies.engine === undefined) {
      throw new MetaError("not_found", "The engine status API is not configured.");
    }
    const context = await dependencies.authenticate(request);
    const result = await (operation === "status"
      ? dependencies.engine.status()
      : dependencies.engine.testConnection());
    return jsonResponse(result, {
      headers: {
        "x-correlation-id": context.correlationId,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const metaError = toMetaError(error);
    const correlationId = resolveCorrelationId(request.headers);
    return Response.json(createErrorEnvelope(metaError.code, correlationId), {
      status: metaError.status,
      headers: { "x-correlation-id": correlationId },
    });
  }
}

function hasRequiredCapability(
  context: TenantContext,
  requiredCapability: string,
  now: number,
): boolean {
  if (hasCapability(context, requiredCapability, now)) return true;
  return requiredCapability === "schema:read" && hasCapability(context, "schema:manage", now);
}

async function handleSql(
  request: Request,
  dependencies: SqliteMetaDependencies,
  now: () => number,
): Promise<Response> {
  try {
    const headerTenant = parseTenantIdentityFromHeaders(request.headers);
    const context = await dependencies.authenticate(request);
    if (!sameTenant(headerTenant, context.tenant)) {
      throw new MetaError("forbidden", "Resolved project does not match request tenant.");
    }
    const sql = readSql(await readBody(request));
    const operation = sqlOperation(sql);
    const requiredCapability = operation === "read" ? "data:read" : "sql:execute";
    if (!hasRequiredCapability(context, requiredCapability, now())) {
      throw new MetaError("forbidden", "SQL execution is not permitted.");
    }
    const project = await dependencies.resolveProject(context);
    if (!sameTenant(project.tenant, context.tenant)) {
      throw new MetaError("forbidden", "Resolved project does not match request tenant.");
    }
    assertSqlTables(sql, await manifest(project));
    if (operation === "write") {
      const result = await executeSqlWriteIdempotently(
        project,
        context,
        dependencies,
        readIdempotencyKey(request.headers),
        sql,
      );
      return jsonResponse(result, { headers: { "x-correlation-id": context.correlationId } });
    }
    const result = await project.engine.execute<Record<string, EngineValue>>({ sql });
    recordDataAudit(dependencies, context, "run_sql_read", sql, result.changes);
    return jsonResponse(
      Object.freeze({ rows: Object.freeze(result.rows.map(rowDto)), changes: result.changes }),
      { headers: { "x-correlation-id": context.correlationId } },
    );
  } catch (error) {
    const metaError = toMetaError(error);
    const correlationId = resolveCorrelationId(request.headers);
    return Response.json(createErrorEnvelope(metaError.code, correlationId), {
      status: metaError.status,
      headers: { "x-correlation-id": correlationId },
    });
  }
}

async function executeSqlWriteIdempotently(
  project: SqliteMetaProject,
  context: TenantContext,
  dependencies: SqliteMetaDependencies,
  idempotencyKey: string,
  sql: string,
): Promise<SqlWriteResponse> {
  const requestHash = createHash("sha256")
    .update(stableJson({ operation: "run_sql_write", sql }))
    .digest("hex");
  const response = await project.engine.transaction(async (transaction) => {
    await initializeRowMutationTables(transaction);
    const tenant = tenantParameters(context.tenant);
    const existing = (
      await transaction.execute<IdempotencyLedgerRow>({
        sql: `SELECT request_hash, response_payload FROM _mekka_idempotency_ledger
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND actor_kind = ? AND actor_id = ?
          AND idempotency_key = ?`,
        parameters: [...tenant, context.actor.kind, context.actor.id, idempotencyKey],
      })
    ).rows[0];
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new MetaError("conflict", "Idempotency key was reused with a different request.");
      }
      return parseSqlWriteResponse(existing.response_payload);
    }

    const executed = await transaction.execute<Record<string, EngineValue>>({ sql });
    if (executed.rows.length > maxRowPageSize) {
      throw new MetaError("quota", `SQL writes may return at most ${maxRowPageSize} rows.`);
    }
    const result = Object.freeze({
      rows: Object.freeze(executed.rows.map(rowDto)),
      changes: executed.changes,
      idempotencyKey,
    });
    const audit = Object.freeze({
      action: "run_sql_write" as const,
      actorId: context.actor.id,
      statementHash: createHash("sha256").update(sql).digest("hex"),
      rowCount: executed.changes,
    });
    await transaction.execute({
      sql: `INSERT INTO _mekka_idempotency_ledger (
          organization_id, project_id, environment_id, branch_id, generation,
          actor_kind, actor_id, idempotency_key, request_hash, status, response_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      parameters: [
        ...tenant,
        context.actor.kind,
        context.actor.id,
        idempotencyKey,
        requestHash,
        JSON.stringify(result),
      ],
    });
    await transaction.execute({
      sql: `INSERT INTO _mekka_audit_outbox (
          organization_id, project_id, environment_id, branch_id, generation, payload
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      parameters: [...tenant, JSON.stringify(audit)],
    });
    return result;
  });
  await flushAuditOutbox(project.engine, dependencies, context.tenant);
  return response;
}

function readSql(body: Record<string, unknown>): string {
  const value = body.sql;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxSqlLength) {
    throw new MetaError("validation", "SQL must be a bounded non-empty string.");
  }
  if (containsMultipleStatements(value)) {
    throw new MetaError("validation", "Only one SQL statement is allowed.");
  }
  if (
    /\b(?:attach|detach|pragma|vacuum|begin|commit|rollback|savepoint|release|alter|create|drop|replace|reindex|analyze|trigger|virtual|load_extension)\b/i.test(
      value,
    )
  ) {
    throw new MetaError("unsupported", "This SQL statement is not permitted.");
  }
  if (/\b(?:sqlite_master|sqlite_schema|_mekka_[A-Za-z0-9_]*)\b/i.test(value)) {
    throw new MetaError("forbidden", "System tables are not available through SQL editor.");
  }
  return value.trim();
}

function sqlOperation(sql: string): SqlOperation {
  if (/^select\b/i.test(sql)) {
    const limit = /\blimit\s+(\d+)\s*;?$/i.exec(sql);
    if (limit === null || Number(limit[1]) > maxRowPageSize) {
      throw new MetaError("validation", `SELECT statements require LIMIT <= ${maxRowPageSize}.`);
    }
    return "read";
  }
  if (/^(?:insert|update|delete)\b/i.test(sql)) {
    if (/^(?:update|delete)\b/i.test(sql) && !hasTopLevelKeyword(sql, "where")) {
      throw new MetaError("validation", "UPDATE and DELETE statements require WHERE.");
    }
    return "write";
  }
  throw new MetaError("unsupported", "Only SELECT, INSERT, UPDATE and DELETE are supported.");
}

function hasTopLevelKeyword(sql: string, keyword: string): boolean {
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    const nextCharacter = sql.charAt(index + 1);
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        if (quote !== "]" && nextCharacter === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "-" && nextCharacter === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0 && /[A-Za-z_]/.test(character)) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/.test(sql.charAt(end))) end += 1;
      if (sql.slice(index, end).toLowerCase() === keyword) return true;
      index = end - 1;
    }
  }
  return false;
}

function assertSqlTables(sql: string, schema: SchemaManifest): void {
  if (
    /\bjoin\b/i.test(sql) ||
    /\bfrom\s*\(/i.test(sql) ||
    /\bfrom\s+"?[A-Za-z_][A-Za-z0-9_]*"?\s*,/i.test(sql)
  ) {
    throw new MetaError("unsupported", "SQL joins and subqueries are not supported.");
  }
  const references = sql.matchAll(/\b(?:from|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi);
  for (const reference of references) {
    const table = reference[1];
    if (table === undefined || !schema.tables.some((candidate) => candidate.name === table)) {
      throw new MetaError(
        "validation",
        "SQL references a table that is not exposed by the schema.",
      );
    }
  }
}

function readBoundedQueryInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new MetaError("validation", "Pagination value is out of range.");
  }
  return parsed;
}

function requireExposedColumn(table: SchemaTable, value: string): string {
  if (!identifierPattern.test(value))
    throw new MetaError("validation", "Column must be a SQLite identifier.");
  if (!table.columns.some((column) => column.name === value && column.hidden === "none")) {
    throw new MetaError("validation", "Column is not exposed by the schema.");
  }
  return value;
}

function readRowValues(
  body: Record<string, unknown>,
  table: SchemaTable,
  requireValues: boolean,
): RowInput {
  const values = body.values === undefined ? body : readRecord(body.values, "values");
  const entries = Object.entries(values);
  if ((requireValues && entries.length === 0) || entries.length > 64) {
    throw new MetaError("validation", "Row values must be a non-empty bounded object.");
  }
  const parsed: Record<string, RowValue> = {};
  for (const [column, value] of entries) {
    requireExposedColumn(table, column);
    if (typeof value !== "string" && typeof value !== "number" && value !== null) {
      throw new MetaError("validation", "Row values must be strings, numbers or null.");
    }
    if (typeof value === "string" && value.length > 16_384) {
      throw new MetaError("quota", "Row value exceeds the allowed size.");
    }
    parsed[column] = value;
  }
  return Object.freeze(parsed);
}

function readRowKey(
  body: Record<string, unknown>,
  table: SchemaTable,
): Readonly<{ column: string; value: RowValue }> {
  const key = readRecord(body.key, "key");
  const column = requireExposedColumn(table, readStringField(key, "column"));
  const value = key.value;
  if (typeof value !== "string" && typeof value !== "number" && value !== null) {
    throw new MetaError("validation", "Row key value must be a string, number or null.");
  }
  return Object.freeze({ column, value });
}

function readDeleteRowKey(
  request: Request,
  table: SchemaTable,
): Readonly<{ column: string; value: RowValue }> {
  const search = new URL(request.url).searchParams;
  const column = requireExposedColumn(table, search.get("key_column") ?? "");
  const rawValue = search.get("key_value");
  if (rawValue === null || rawValue.length > 16_384) {
    throw new MetaError("validation", "Row key value is required.");
  }
  return Object.freeze({ column, value: rawValue });
}

function readRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetaError("validation", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readStringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string") throw new MetaError("validation", `${name} must be a string.`);
  return value;
}

function rowDto(row: Record<string, EngineValue>): Record<string, RowValue> {
  const result: Record<string, RowValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || value === null)
      result[column] = value;
    else result[column] = String(value);
  }
  return Object.freeze(result);
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function containsMultipleStatements(sql: string): boolean {
  let quote: "'" | '"' | "`" | null = null;
  let semicolonFound = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    const nextCharacter = sql.charAt(index + 1);
    if (quote !== null) {
      if (character === quote) {
        if (nextCharacter === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === ";") semicolonFound = true;
    else if (semicolonFound && !/\s/.test(character)) return true;
  }
  return false;
}

function recordDataAudit(
  dependencies: SqliteMetaDependencies,
  context: TenantContext,
  action: Extract<
    SqliteMetaAuditEvent["action"],
    `create_row` | `update_row` | `delete_row` | `run_sql_read` | `run_sql_write`
  >,
  statement: string,
  rowCount: number,
): void {
  dependencies.recordAudit({
    action,
    actorId: context.actor.id,
    statementHash: createHash("sha256").update(statement).digest("hex"),
    rowCount,
  });
}

async function mutateRowIdempotently(
  project: SqliteMetaProject,
  context: TenantContext,
  dependencies: SqliteMetaDependencies,
  idempotencyKey: string,
  request: Readonly<Record<string, unknown>>,
  statement: string,
  mutation: (transaction: EngineExecutor) => Promise<number>,
): Promise<RowMutationResponse> {
  const requestHash = createHash("sha256").update(stableJson(request)).digest("hex");
  const response = await project.engine.transaction(async (transaction) => {
    await initializeRowMutationTables(transaction);
    const tenant = tenantParameters(context.tenant);
    const existing = (
      await transaction.execute<IdempotencyLedgerRow>({
        sql: `SELECT request_hash, response_payload FROM _mekka_idempotency_ledger
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND actor_kind = ? AND actor_id = ?
          AND idempotency_key = ?`,
        parameters: [...tenant, context.actor.kind, context.actor.id, idempotencyKey],
      })
    ).rows[0];
    if (existing !== undefined) {
      if (existing.request_hash !== requestHash) {
        throw new MetaError("conflict", "Idempotency key was reused with a different request.");
      }
      return parseRowMutationResponse(existing.response_payload);
    }
    const changes = await mutation(transaction);
    const result = Object.freeze({ changes, idempotencyKey });
    const audit = Object.freeze({
      action: request.operation as SqliteMetaAuditEvent["action"],
      actorId: context.actor.id,
      statementHash: createHash("sha256").update(statement).digest("hex"),
      rowCount: changes,
    });
    await transaction.execute({
      sql: `INSERT INTO _mekka_idempotency_ledger (
          organization_id, project_id, environment_id, branch_id, generation,
          actor_kind, actor_id, idempotency_key, request_hash, status, response_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?)`,
      parameters: [
        ...tenant,
        context.actor.kind,
        context.actor.id,
        idempotencyKey,
        requestHash,
        JSON.stringify(result),
      ],
    });
    await transaction.execute({
      sql: `INSERT INTO _mekka_audit_outbox (
          organization_id, project_id, environment_id, branch_id, generation, payload
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      parameters: [...tenant, JSON.stringify(audit)],
    });
    return result;
  });
  await flushAuditOutbox(project.engine, dependencies, context.tenant);
  return response;
}

async function initializeRowMutationTables(storage: EngineExecutor): Promise<void> {
  await storage.execute({
    sql: `CREATE TABLE IF NOT EXISTS _mekka_idempotency_ledger (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, generation INTEGER NOT NULL, actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'committed'), response_payload TEXT NOT NULL,
      PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation, actor_kind, actor_id, idempotency_key)
    ) STRICT`,
  });
  await storage.execute({
    sql: `CREATE TABLE IF NOT EXISTS _mekka_audit_outbox (
      id INTEGER PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL, branch_id TEXT NOT NULL, generation INTEGER NOT NULL,
      payload TEXT NOT NULL
    ) STRICT`,
  });
}

async function flushAuditOutbox(
  storage: EngineExecutor,
  dependencies: SqliteMetaDependencies,
  tenant: TenantIdentity,
): Promise<void> {
  await initializeRowMutationTables(storage);
  const rows = (
    await storage.execute<AuditOutboxRow>({
      sql: `SELECT id, payload FROM _mekka_audit_outbox
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? ORDER BY id LIMIT 100`,
      parameters: tenantParameters(tenant),
    })
  ).rows;
  for (const row of rows) {
    let audit: SqliteMetaAuditEvent;
    try {
      audit = parseAuditEvent(row.payload);
      dependencies.recordAudit(audit);
    } catch {
      return;
    }
    await storage.execute({
      sql: "DELETE FROM _mekka_audit_outbox WHERE id = ?",
      parameters: [row.id],
    });
  }
}

function parseRowMutationResponse(payload: string): RowMutationResponse {
  try {
    const value = readRecord(JSON.parse(payload), "idempotency response");
    if (
      typeof value.changes !== "number" ||
      !Number.isSafeInteger(value.changes) ||
      value.changes < 0
    ) {
      throw new Error("invalid changes");
    }
    if (
      typeof value.idempotencyKey !== "string" ||
      !idempotencyKeyPattern.test(value.idempotencyKey)
    ) {
      throw new Error("invalid idempotency key");
    }
    return Object.freeze({ changes: value.changes, idempotencyKey: value.idempotencyKey });
  } catch {
    throw new MetaError("infrastructure", "Idempotency ledger is invalid.");
  }
}

function parseSqlWriteResponse(payload: string): SqlWriteResponse {
  try {
    const value = readRecord(JSON.parse(payload), "SQL idempotency response");
    if (
      !Array.isArray(value.rows) ||
      value.rows.length > maxRowPageSize ||
      typeof value.changes !== "number" ||
      !Number.isSafeInteger(value.changes) ||
      value.changes < 0 ||
      typeof value.idempotencyKey !== "string" ||
      !idempotencyKeyPattern.test(value.idempotencyKey)
    ) {
      throw new Error("invalid SQL idempotency response");
    }
    const rows = value.rows.map((row) => {
      const record = readRecord(row, "SQL idempotency row");
      return rowDto(record as Record<string, EngineValue>);
    });
    return Object.freeze({
      rows: Object.freeze(rows),
      changes: value.changes,
      idempotencyKey: value.idempotencyKey,
    });
  } catch {
    throw new MetaError("infrastructure", "SQL idempotency record is invalid.");
  }
}

function parseAuditEvent(payload: string): SqliteMetaAuditEvent {
  const value = readRecord(JSON.parse(payload), "audit outbox");
  if (
    typeof value.action !== "string" ||
    typeof value.actorId !== "string" ||
    typeof value.statementHash !== "string" ||
    typeof value.rowCount !== "number"
  ) {
    throw new MetaError("infrastructure", "Audit outbox is invalid.");
  }
  return Object.freeze({
    action: value.action as SqliteMetaAuditEvent["action"],
    actorId: value.actorId,
    statementHash: value.statementHash,
    rowCount: value.rowCount,
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
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

async function mutate(
  context: TenantContext,
  project: SqliteMetaProject,
  dependencies: SqliteMetaDependencies,
  headers: Headers,
  action: SqliteMetaAuditEvent["action"],
  table: string,
  expectedSchemaHash: string,
  sql: string,
  destructive: boolean,
): Promise<MutationResult<SqliteMetaTable | SqliteMetaIndex>> {
  const idempotencyKey = readIdempotencyKey(headers);
  const artifact = createMigrationArtifact({
    id: migrationId(context, action, table, idempotencyKey),
    actorId: context.actor.id,
    idempotencyKey,
    expectedSchemaHash,
    sql,
  });
  const preflight = await preflightEngineMigration(project.engine, artifact);
  const checkpointPath = join(dependencies.checkpointDirectory, `${artifact.id}.sqlite`);
  const deletedTable =
    action === "delete_table"
      ? preflight === null
        ? tableDto(requireTable(await manifest(project), table))
        : readCheckpointTable(checkpointPath, dependencies.checkpointDirectory, table)
      : undefined;
  if (preflight !== null) {
    dependencies.recordAudit({
      action,
      actorId: context.actor.id,
      migrationHash: preflight.migrationHash,
      checkpointId: destructive ? `checkpoint-${artifact.id}` : null,
    });
    return mutationResult(
      deletedTable ?? (await replayedResource(project, action, table, sql)),
      sql,
      destructive ? `checkpoint-${artifact.id}` : null,
    );
  }
  if (destructive && project.localStorage === undefined) {
    throw new MetaError(
      "unsupported",
      "Destructive schema changes require a configured remote backup provider.",
    );
  }
  const checkpoint = destructive
    ? createCheckpoint(project.localStorage as StorageAdapter, {
        id: `checkpoint-${artifact.id}`,
        checkpointPath,
        checkpointDirectory: dependencies.checkpointDirectory,
      })
    : undefined;
  let result: Awaited<ReturnType<typeof applyEngineMigration>>;
  try {
    result = await applyEngineMigration(
      project.engine,
      artifact,
      checkpoint === undefined ? {} : { checkpoint },
    );
  } catch (error) {
    if (checkpoint !== undefined) discardCheckpoint(checkpoint);
    throw error;
  }
  project.schemaCache?.invalidate();
  dependencies.recordAudit({
    action,
    actorId: context.actor.id,
    migrationHash: result.migrationHash,
    checkpointId: checkpoint?.id ?? null,
  });
  if (deletedTable !== undefined) return mutationResult(deletedTable, sql, checkpoint?.id ?? null);
  const current = await manifest(project);
  if (action === "create_index") {
    const index = tableDto(requireTable(current, table)).indexes.find((candidate) =>
      sql.includes(quote(candidate.name)),
    );
    if (index === undefined) {
      throw new MetaError("infrastructure", "Created index could not be resolved.");
    }
    return mutationResult(index, sql, checkpoint?.id ?? null);
  }
  const targetName = action === "rename_table" ? sql.match(/TO "([^"]+)"$/)?.[1] : table;
  return mutationResult(
    tableDto(requireTable(current, targetName ?? table)),
    sql,
    checkpoint?.id ?? null,
  );
}

async function replayedResource(
  project: SqliteMetaProject,
  action: SqliteMetaAuditEvent["action"],
  table: string,
  sql: string,
): Promise<SqliteMetaTable | SqliteMetaIndex> {
  const current = await manifest(project);
  if (action === "create_index") {
    const index = tableDto(requireTable(current, table)).indexes.find((candidate) =>
      sql.includes(quote(candidate.name)),
    );
    if (index !== undefined) return index;
  }
  const targetName = action === "rename_table" ? sql.match(/TO "([^"]+)"$/)?.[1] : table;
  return tableDto(requireTable(current, targetName ?? table));
}

async function preflightEngineMigration(
  engine: Engine,
  artifact: MigrationArtifact,
): Promise<Readonly<{ migrationHash: string; schemaHash: string }> | null> {
  const currentSchemaHash = (await buildSchemaManifestAsync(engine)).hash;
  const ledgerExists =
    (
      await engine.execute({
        sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_mekka_migrations'",
      })
    ).rows[0] !== undefined;
  const existing = ledgerExists ? await readEngineMigration(engine, artifact.id) : null;
  if (existing !== null) {
    if (existing.hash !== artifact.hash) {
      throw new MetaError("conflict", "Migration identifier was reused with a different artifact.");
    }
    if (existing.state !== "applied") {
      throw new MetaError("infrastructure", "Migration ledger is in an unexpected state.");
    }
    return Object.freeze({ migrationHash: artifact.hash, schemaHash: existing.schemaHash });
  }
  if (currentSchemaHash !== artifact.expectedSchemaHash) {
    throw new MetaError("conflict", "Migration expected schema does not match target.");
  }
  return null;
}

async function applyEngineMigration(
  engine: Engine,
  artifact: MigrationArtifact,
  options: Readonly<{ checkpoint?: BackupArtifact }>,
): Promise<Readonly<{ migrationHash: string; schemaHash: string }>> {
  return engine.transaction(async (transaction) => {
    const currentSchemaHash = (await buildSchemaManifestAsync(transaction)).hash;
    await transaction.execute({
      sql: "CREATE TABLE IF NOT EXISTS _mekka_migrations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, expected_schema_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('applying', 'applied')), applied_schema_hash TEXT)",
    });
    const existing = await readEngineMigration(transaction, artifact.id);
    if (existing !== null) {
      if (existing.hash !== artifact.hash) {
        throw new MetaError(
          "conflict",
          "Migration identifier was reused with a different artifact.",
        );
      }
      if (existing.state !== "applied") {
        throw new MetaError("infrastructure", "Migration ledger is in an unexpected state.");
      }
      return Object.freeze({ migrationHash: artifact.hash, schemaHash: existing.schemaHash });
    }
    if (currentSchemaHash !== artifact.expectedSchemaHash) {
      throw new MetaError("conflict", "Migration expected schema does not match target.");
    }
    if (
      options.checkpoint !== undefined &&
      options.checkpoint.sourceSchemaHash !== currentSchemaHash
    ) {
      throw new MetaError("conflict", "Schema checkpoint does not match the migration target.");
    }
    await transaction.execute({
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
    await transaction.execute({ sql: artifact.sql });
    const schemaHash = (await buildSchemaManifestAsync(transaction)).hash;
    await transaction.execute({
      sql: "UPDATE _mekka_migrations SET state = ?, applied_schema_hash = ? WHERE id = ?",
      parameters: ["applied", schemaHash, artifact.id],
    });
    return Object.freeze({ migrationHash: artifact.hash, schemaHash });
  });
}

async function readEngineMigration(
  executor: EngineExecutor,
  id: string,
): Promise<Readonly<{ hash: string; state: string; schemaHash: string }> | null> {
  const row = (
    await executor.execute<{
      hash: string;
      state: string;
      appliedSchemaHash: string | null;
    }>({
      sql: "SELECT hash, state, applied_schema_hash AS appliedSchemaHash FROM _mekka_migrations WHERE id = ?",
      parameters: [id],
    })
  ).rows[0];
  if (row === undefined) return null;
  if (
    typeof row.hash !== "string" ||
    typeof row.state !== "string" ||
    typeof row.appliedSchemaHash !== "string"
  ) {
    throw new MetaError("infrastructure", "Migration ledger contains an invalid row.");
  }
  return Object.freeze({ hash: row.hash, state: row.state, schemaHash: row.appliedSchemaHash });
}

function readCheckpointTable(path: string, directory: string, table: string): SqliteMetaTable {
  if (!existsSync(path)) {
    return Object.freeze({ name: table, columns: [], primaryKey: [], indexes: [] });
  }
  const checkpoint = openStorageAdapter({ databasePath: path, databaseDirectory: directory });
  try {
    return tableDto(requireTable(buildSchemaManifest(checkpoint), table));
  } finally {
    checkpoint.close();
  }
}

function mutationResult<T>(
  resource: T,
  migrationSql: string,
  checkpointId: string | null,
): MutationResult<T> {
  return Object.freeze({ resource, migrationSql, checkpointId });
}

function readIdempotencyKey(headers: Headers): string {
  const key = headers.get("idempotency-key");
  if (key === null || key === undefined || !idempotencyKeyPattern.test(key)) {
    throw new MetaError("validation", "A valid Idempotency-Key header is required.");
  }
  return key;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !== "application/json") {
    throw new MetaError("validation", "Content-Type must be application/json.");
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxRequestBodyBytes) {
    throw new MetaError("quota", "Request body exceeds the allowed size.");
  }
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > maxRequestBodyBytes) {
      throw new MetaError("quota", "Request body exceeds the allowed size.");
    }
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MetaError("validation", "Request body must be a JSON object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof MetaError) {
      throw error;
    }
    throw new MetaError("validation", "Request body must be valid JSON.");
  }
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > maxResultBodyBytes) {
    throw new MetaError("quota", "Response exceeds the allowed size.");
  }
  const headers = new Headers();
  const sourceHeaders = init?.headers;
  if (sourceHeaders instanceof Headers) {
    sourceHeaders.forEach((value, name) => {
      headers.set(name, value);
    });
  } else if (Array.isArray(sourceHeaders)) {
    for (const [name, value] of sourceHeaders) {
      if (name !== undefined && value !== undefined) headers.set(name, value);
    }
  } else if (sourceHeaders !== undefined) {
    for (const [name, value] of Object.entries(sourceHeaders)) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  return new Response(serialized, {
    ...init,
    headers,
  });
}

async function manifest(project: SqliteMetaProject): Promise<SchemaManifest> {
  return project.schemaCache?.get() ?? buildSchemaManifestAsync(project.engine);
}

function tablesDto(schema: SchemaManifest): readonly SqliteMetaTable[] {
  return schema.tables.map(tableDto);
}

function tableDto(table: SchemaTable): SqliteMetaTable {
  const columns = table.columns
    .filter((column) => column.hidden === "none")
    .map((column) =>
      Object.freeze({
        name: column.name,
        type: column.type,
        nullable: !column.notNull,
        primaryKeyPosition: column.primaryKeyPosition,
        defaultValue: column.defaultValue,
      }),
    );
  const indexes = table.indexes
    .filter((index) => index.origin === "created")
    .map((index) =>
      Object.freeze({
        name: index.name,
        table: table.name,
        unique: index.unique,
        columns: Object.freeze(
          index.columns
            .filter((column) => column.key && column.name !== null)
            .map((column) => column.name as string),
        ),
      }),
    );
  return Object.freeze({
    name: table.name,
    columns: Object.freeze(columns),
    primaryKey: Object.freeze(
      columns
        .filter((column) => column.primaryKeyPosition > 0)
        .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
        .map((column) => column.name),
    ),
    indexes: Object.freeze(indexes),
  });
}

function createTableSql(name: string, columns: readonly ColumnInput[]): string {
  const primaryKey = columns
    .filter((column) => column.primaryKey === true)
    .map((column) => quote(column.name));
  return `CREATE TABLE ${quote(name)} (${[
    ...columns.map(columnSql),
    ...(primaryKey.length === 0 ? [] : [`PRIMARY KEY (${primaryKey.join(", ")})`]),
  ].join(", ")})`;
}

function columnSql(column: ColumnInput): string {
  const type = readType(column.type);
  return `${quote(column.name)} ${type}${column.nullable === false || column.primaryKey === true ? " NOT NULL" : ""}`;
}

function readColumns(body: Record<string, unknown>): readonly ColumnInput[] {
  const value = body.columns;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new MetaError("validation", "columns must be a non-empty bounded array.");
  }
  const columns = value.map((item) => readColumnValue(item));
  if (new Set(columns.map((column) => column.name)).size !== columns.length) {
    throw new MetaError("validation", "Column names must be unique.");
  }
  return Object.freeze(columns);
}

function readColumn(body: Record<string, unknown>): ColumnInput {
  return readColumnValue(body);
}

function readColumnValue(value: unknown): ColumnInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MetaError("validation", "Column must be an object.");
  }
  const body = value as Record<string, unknown>;
  const nullable = readOptionalBoolean(body, "nullable");
  const primaryKey = readOptionalBoolean(body, "primaryKey");
  return Object.freeze({
    name: readIdentifier(body, "name"),
    type: readType(body.type),
    ...(nullable === undefined ? {} : { nullable }),
    ...(primaryKey === undefined ? {} : { primaryKey }),
  });
}

function readIdentifier(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new MetaError("validation", `${name} must be a SQLite identifier.`);
  }
  if (isReservedSchemaIdentifier(value)) {
    throw new MetaError("validation", `${name} uses a reserved schema identifier.`);
  }
  return value;
}

function readRouteIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new MetaError("validation", `${name} must be a SQLite identifier.`);
  }
  return value;
}

function readIdentifierArray(body: Record<string, unknown>, name: string): readonly string[] {
  const value = body[name];
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new MetaError("validation", `${name} must be a non-empty bounded array.`);
  }
  const values = value.map((entry) => {
    if (typeof entry !== "string" || !identifierPattern.test(entry)) {
      throw new MetaError("validation", `${name} must contain SQLite identifiers.`);
    }
    return entry;
  });
  if (new Set(values).size !== values.length) {
    throw new MetaError("validation", `${name} must not contain duplicates.`);
  }
  return Object.freeze(values);
}

function readType(value: unknown): string {
  if (typeof value !== "string" || !allowedTypes.has(value.toUpperCase())) {
    throw new MetaError(
      "unsupported",
      "Only INTEGER, TEXT, REAL, BLOB and NUMERIC types are supported.",
    );
  }
  return value.toUpperCase();
}

function readOptionalBoolean(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new MetaError("validation", `${name} must be boolean.`);
  }
  return value;
}

function readSchemaHash(body: Record<string, unknown>): string {
  const value = body.expectedSchemaHash;
  if (typeof value !== "string" || !schemaHashPattern.test(value)) {
    throw new MetaError("validation", "expectedSchemaHash must be a SHA-256 hash.");
  }
  return value;
}

function readExpectedSchemaQuery(request: Request): string {
  const value = new URL(request.url).searchParams.get("expected_schema_hash");
  if (value === null || !schemaHashPattern.test(value)) {
    throw new MetaError("validation", "expected_schema_hash must be a SHA-256 hash.");
  }
  return value;
}

function requireTable(schema: SchemaManifest, name: string): SchemaTable {
  const table = schema.tables.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new MetaError("validation", "Table is not exposed by the schema.");
  }
  return table;
}

function migrationId(
  context: TenantContext,
  action: SqliteMetaAuditEvent["action"],
  table: string,
  idempotencyKey: string,
): string {
  return `meta-${createHash("sha256")
    .update(
      `${context.tenant.organizationId}:${context.tenant.projectId}:${context.tenant.environmentId}:${context.tenant.branchId}:${context.tenant.generation}:${context.actor.id}:${action}:${table}:${idempotencyKey}`,
    )
    .digest("hex")}`;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sameTenant(left: TenantIdentity, right: TenantIdentity): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.branchId === right.branchId &&
    left.generation === right.generation
  );
}
