import { createHash } from "node:crypto";
import {
  createMcpHttpResponse,
  type McpCapabilityStore,
  type McpLogEntry,
  type McpMutationWorkflow,
  type McpProtectedResource,
  type McpTokenVerifier,
} from "@mekka/mcp";
import {
  type PolicyDocument,
  PolicyError,
  rewritePolicyQuery,
  simulatePolicy,
} from "@mekka/policy-engine";
import {
  createErrorEnvelope,
  type ErrorCode,
  hasCapability,
  ProtocolError,
  parseTenantIdentityFromHeaders,
  resolveCorrelationId,
  type TenantContext,
  type TenantIdentity,
  tenantHeaders,
} from "@mekka/protocol";
import { createMutationAst, type MutationInput, parseQuery, QueryAstError } from "@mekka/query-ast";
import { appendChangeEvents, type ChangeRecord, type PendingChange } from "@mekka/realtime-core";
import { buildSchemaManifest, type SchemaManifest, type SchemaTable } from "@mekka/schema-manifest";
import { compileMutation, compileSelect, compileSelectCount } from "@mekka/sqlite-compiler";
import type {
  ObjectStorageCore,
  StorageAdapter,
  StorageExecutor,
  StorageResult,
  StorageStatement,
  StorageValue,
} from "@mekka/storage-core";
import { Elysia } from "elysia";
import { openApiDocument } from "./openapi";
import {
  createRealtimeRoutes,
  type RealtimeChannelRule,
  type RealtimeGatewayDependencies,
} from "./realtime";
import { createStorageRoutes } from "./storage";
import {
  createSupabaseErrorBody,
  isSupabaseDataRequest,
  parseSupabaseMutationPreference,
  type SupabaseDataDependencies,
  validateSupabaseReadRequest,
} from "./supabase-data";

export type RestQueryExecutor = Readonly<{
  execute<Row extends Record<string, StorageValue> = Record<string, StorageValue>>(
    statement: StorageStatement,
    timeoutMs: number,
  ): StorageResult<Row>;
}>;

export type RestProject = Readonly<{
  tenant: TenantIdentity;
  storage: StorageAdapter;
  objectStorage: ObjectStorageCore;
  executor: RestQueryExecutor;
  policies: PolicyDocument;
  realtimeChannels: readonly RealtimeChannelRule[];
}>;

export type GatewayMetric = Readonly<{
  outcome: "success" | "client_error" | "rate_limited" | "timeout" | "infrastructure_error";
  status: number;
  durationMs: number;
  rowCount: number;
}>;

export type StorageAuditEvent = Readonly<{
  action:
    | "storage.bucket.create"
    | "storage.bucket.update"
    | "storage.bucket.delete"
    | "storage.object.create"
    | "storage.object.sign"
    | "storage.object.delete"
    | "storage.upload.abort";
  tenant: TenantIdentity;
  actor: TenantContext["actor"];
  correlationId: TenantContext["correlationId"];
  bucketName: string;
  objectPathHash?: string;
}>;

export type GatewayMcpDependencies = Readonly<{
  tokenVerifier: McpTokenVerifier;
  capabilityStore: McpCapabilityStore;
  protectedResource: McpProtectedResource;
  listLogs(context: TenantContext): Promise<readonly McpLogEntry[]> | readonly McpLogEntry[];
  mutations?: McpMutationWorkflow;
}>;

export type GatewayDependencies = Readonly<{
  authenticate(request: Request): Promise<TenantContext> | TenantContext;
  resolveProject(context: TenantContext): Promise<RestProject> | RestProject;
  resolveProjectByTenant(tenant: TenantIdentity): Promise<RestProject> | RestProject;
  consumeRateLimit(context: TenantContext): Promise<boolean> | boolean;
  consumeSignedRateLimit(request: Request): Promise<boolean> | boolean;
  storagePublicOrigin: string;
  recordMetric(metric: GatewayMetric): Promise<void> | void;
  recordStorageAudit(event: StorageAuditEvent): Promise<void> | void;
  mcp?: GatewayMcpDependencies;
  supabaseData?: SupabaseDataDependencies;
  now?: () => number;
  limits?: Partial<GatewayLimits>;
}> &
  RealtimeGatewayDependencies;

export type GatewayLimits = Readonly<{
  maxRows: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  queryTimeoutMs: number;
  maxObjectBytes: number;
  maxStorageChunkBytes: number;
  maxSignedUrlTtlSeconds: number;
  resumableUploadTtlMs: number;
}>;

type MutationResponse = Readonly<{
  status: number;
  body: string | null;
  headers: Readonly<Record<string, string>>;
}>;

type MutationTransactionResult =
  | Readonly<{ kind: "response"; response: MutationResponse; rowCount: number }>
  | Readonly<{ kind: "idempotency_conflict" }>;

type MutationPreference = Readonly<{
  returnRepresentation: boolean;
  countExact: boolean;
  mergeDuplicates: boolean;
}>;

export class RestQueryTimeoutError extends Error {
  constructor() {
    super("The query exceeded its execution deadline.");
    this.name = "RestQueryTimeoutError";
  }
}

const defaultLimits: GatewayLimits = Object.freeze({
  maxRows: 100,
  maxRequestBytes: 1_000_000,
  maxResponseBytes: 1_000_000,
  queryTimeoutMs: 1_000,
  maxObjectBytes: 10 * 1024 * 1024,
  maxStorageChunkBytes: 1024 * 1024,
  maxSignedUrlTtlSeconds: 3_600,
  resumableUploadTtlMs: 24 * 60 * 60 * 1_000,
});

export function createGatewayApp(dependencies: GatewayDependencies) {
  const limits = resolveLimits(dependencies.limits);
  const now = dependencies.now ?? Date.now;
  const mcp =
    dependencies.mcp === undefined
      ? null
      : {
          resolveProject: async (context: TenantContext) => {
            const project = await dependencies.resolveProject(context);
            return {
              tenant: project.tenant,
              storage: project.storage,
              policies: project.policies,
            };
          },
          listLogs: dependencies.mcp.listLogs,
          tokenVerifier: dependencies.mcp.tokenVerifier,
          capabilityStore: dependencies.mcp.capabilityStore,
          protectedResource: dependencies.mcp.protectedResource,
          ...(dependencies.mcp.mutations === undefined
            ? {}
            : { mutations: dependencies.mcp.mutations }),
          now,
        };

  const app = new Elysia({ name: "gateway" })
    .get("/openapi.json", () => openApiDocument)
    .use(createRealtimeRoutes(dependencies))
    .use(createStorageRoutes(dependencies, limits, now))
    .all("/rest/v1/:table", ({ request, params }) => {
      if (request.method === "GET" || request.method === "HEAD") {
        return handleSelect(
          request,
          params.table,
          dependencies,
          limits,
          now,
          request.method === "HEAD",
        );
      }
      if (request.method === "POST") {
        return handleMutation("insert", request, params.table, dependencies, limits, now);
      }
      if (request.method === "PATCH") {
        return handleMutation("update", request, params.table, dependencies, limits, now);
      }
      if (request.method === "DELETE") {
        return handleMutation("delete", request, params.table, dependencies, limits, now);
      }
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD, POST, PATCH, DELETE", "cache-control": "no-store" },
      });
    });
  if (mcp !== null) {
    app.all("/mcp", ({ request }) => handleMcpRequest(request, dependencies, limits, mcp));
    app.all("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
      createMcpHttpResponse(request, mcp),
    );
  }
  return app.onError(({ code, request }) =>
    fallbackErrorResponse(code === "NOT_FOUND" ? 404 : 500, request.headers),
  );
}

async function handleMcpRequest(
  request: Request,
  dependencies: GatewayDependencies,
  limits: GatewayLimits,
  mcp: NonNullable<Parameters<typeof createMcpHttpResponse>[1]>,
): Promise<Response> {
  try {
    if (!(await dependencies.consumeSignedRateLimit(request))) {
      throw new GatewayError("quota", 429, "Request rate limit exceeded.");
    }
    if (request.method === "GET" || request.method === "HEAD" || request.method === "DELETE") {
      return await createMcpHttpResponse(request, mcp);
    }
    validateContentLength(request.headers, limits.maxRequestBytes);
    const body = await readBoundedBody(request, limits.maxRequestBytes);
    return await createMcpHttpResponse(new Request(request, { body }), mcp);
  } catch (error) {
    return toErrorResponse(error, request.headers);
  }
}

async function handleSelect(
  request: Request,
  tableName: string,
  dependencies: GatewayDependencies,
  limits: GatewayLimits,
  now: () => number,
  head: boolean,
): Promise<Response> {
  const startedAt = now();
  let rowCount = 0;

  try {
    const compatibility = isSupabaseDataRequest(request, dependencies.supabaseData);
    const context = await authenticateRestRequest(request, dependencies, compatibility);
    if (compatibility) validateSupabaseReadRequest(request);
    if (!(await dependencies.consumeRateLimit(context))) {
      throw new GatewayError("quota", 429, "Request rate limit exceeded.");
    }
    const project = await dependencies.resolveProject(context);
    if (!sameTenant(project.tenant, context.tenant)) {
      throw new GatewayError("forbidden", 403, "Resolved project does not match request tenant.");
    }

    const manifest = buildSchemaManifest(project.storage);
    const ast = parseQuery(manifest, tableName, new URL(request.url).search);
    const rangedAst = applyRange(ast, request.headers, limits.maxRows);
    const rewritten = rewritePolicyQuery(manifest, project.policies, context, "select", rangedAst);
    const rows = project.executor.execute(
      compileSelect(manifest, rewritten.ast),
      limits.queryTimeoutMs,
    ).rows;
    rowCount = rows.length;
    const body = JSON.stringify(rows);
    if (new TextEncoder().encode(body).byteLength > limits.maxResponseBytes) {
      throw new GatewayError("quota", 413, "Response size limit exceeded.");
    }

    const countRequested = parseCountPreference(request.headers);
    const total = countRequested
      ? readExactCount(
          project.executor.execute(
            compileSelectCount(manifest, rewritten.ast),
            limits.queryTimeoutMs,
          ),
        )
      : null;
    const contentRange = createContentRange(rangedAst.offset, rows.length, total);
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
      "content-range": contentRange,
      "range-unit": "items",
      "x-correlation-id": context.correlationId,
    });
    const status =
      compatibility && countRequested
        ? rangedAst.offset > 0 || (total !== null && rows.length < total)
          ? 206
          : 200
        : countRequested
          ? 206
          : 200;
    recordMetricSafely(dependencies, {
      outcome: "success",
      status,
      durationMs: now() - startedAt,
      rowCount,
    });
    return new Response(head ? null : body, { status, headers });
  } catch (error) {
    const response = toErrorResponse(
      error,
      request.headers,
      isSupabaseDataRequest(request, dependencies.supabaseData),
    );
    recordMetricSafely(dependencies, {
      outcome: metricOutcome(response.status, error),
      status: response.status,
      durationMs: now() - startedAt,
      rowCount,
    });
    return response;
  }
}

async function handleMutation(
  action: "insert" | "update" | "delete",
  request: Request,
  tableName: string,
  dependencies: GatewayDependencies,
  limits: GatewayLimits,
  now: () => number,
): Promise<Response> {
  const startedAt = now();
  let rowCount = 0;

  try {
    const compatibility = isSupabaseDataRequest(request, dependencies.supabaseData);
    const context = await authenticateRestRequest(request, dependencies, compatibility);
    if (!(await dependencies.consumeRateLimit(context))) {
      throw new GatewayError("quota", 429, "Request rate limit exceeded.");
    }
    if (action !== "delete") validateContentLength(request.headers, limits.maxRequestBytes);
    const project = await dependencies.resolveProject(context);
    if (!sameTenant(project.tenant, context.tenant)) {
      throw new GatewayError("forbidden", 403, "Resolved project does not match request tenant.");
    }

    const preference = compatibility
      ? parseSupabaseMutationPreference(request.headers)
      : parseMutationPreference(request.headers);
    const idempotencyKey = parseIdempotencyKey(request.headers, compatibility);
    const manifest = buildSchemaManifest(project.storage);
    const requestData = await parseMutationRequest(
      request,
      action,
      manifest,
      tableName,
      context,
      limits.maxRows,
      now,
      preference,
      compatibility,
      limits.maxRequestBytes,
    );
    const fingerprint = JSON.stringify({
      action,
      table: tableName,
      schemaHash: createHash("sha256").update(JSON.stringify(manifest.tables)).digest("hex"),
      policyHash: createHash("sha256").update(JSON.stringify(project.policies)).digest("hex"),
      query: requestData.filterQuery,
      body: requestData.values,
      upsert: requestData.upsert,
      returnRepresentation: preference.returnRepresentation,
      countExact: preference.countExact,
      returnColumns: requestData.returnColumns,
    });
    const transactionId = crypto.randomUUID();
    const transactionResult = project.storage.transaction<MutationTransactionResult>(
      (transaction) => {
        createIdempotencyTable(transaction);
        const scope = createIdempotencyScope(context);
        const existing = readIdempotency(transaction, scope, idempotencyKey);
        if (existing !== null) {
          if (existing.fingerprint !== fingerprint) {
            return Object.freeze({ kind: "idempotency_conflict" });
          }
          return Object.freeze({ kind: "response", response: existing.response, rowCount: 0 });
        }

        const mutation = executeMutation(
          transaction,
          project,
          context,
          action,
          tableName,
          requestData,
          preference.returnRepresentation,
          preference.countExact,
          requestData.returnColumns,
          compatibility,
          limits.maxRows,
          limits.maxResponseBytes,
          transactionId,
          startedAt,
        );
        writeIdempotency(transaction, scope, idempotencyKey, fingerprint, mutation.response);
        return Object.freeze({
          kind: "response",
          response: mutation.response,
          rowCount: mutation.rowCount,
        });
      },
    );
    if (transactionResult.kind === "idempotency_conflict") {
      throw new GatewayError(
        "conflict",
        409,
        "Idempotency key was reused with a different request.",
      );
    }
    const { response } = transactionResult;
    rowCount = transactionResult.rowCount;
    const headers = new Headers({ ...response.headers, "x-correlation-id": context.correlationId });
    recordMetricSafely(dependencies, {
      outcome: "success",
      status: response.status,
      durationMs: now() - startedAt,
      rowCount,
    });
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    const response = toErrorResponse(
      error,
      request.headers,
      isSupabaseDataRequest(request, dependencies.supabaseData),
    );
    recordMetricSafely(dependencies, {
      outcome: metricOutcome(response.status, error),
      status: response.status,
      durationMs: now() - startedAt,
      rowCount,
    });
    return response;
  }
}

async function authenticateRestRequest(
  request: Request,
  dependencies: GatewayDependencies,
  compatibility: boolean,
): Promise<TenantContext> {
  const context = compatibility
    ? await dependencies.supabaseData?.authenticateApiKey(request)
    : await dependencies.authenticate(request);
  if (context === undefined) throw new ProtocolError("auth");
  const tenantHeaderNames = [
    tenantHeaders.organizationId,
    tenantHeaders.projectId,
    tenantHeaders.environmentId,
    tenantHeaders.branchId,
    tenantHeaders.generation,
  ];
  const present = tenantHeaderNames.filter((name) => request.headers.has(name)).length;
  if (!compatibility || present > 0) {
    if (present !== tenantHeaderNames.length) throw new ProtocolError("validation");
    const headerTenant = parseTenantIdentityFromHeaders(request.headers);
    if (!sameTenant(headerTenant, context.tenant)) {
      throw new GatewayError("forbidden", 403, "Tenant context does not match request headers.");
    }
  }
  return context;
}

type ParsedMutationRequest = Readonly<{
  values: readonly MutationInput[];
  filterQuery: string;
  upsert: boolean;
  returnColumns: readonly string[] | null;
}>;

function parseMutationPreference(headers: Headers): MutationPreference {
  const values = (headers.get("prefer") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const returnValues = values.filter((value) => value.startsWith("return="));
  if (
    returnValues.length > 1 ||
    (returnValues[0] !== undefined &&
      returnValues[0] !== "return=minimal" &&
      returnValues[0] !== "return=representation")
  ) {
    throw new GatewayError(
      "unsupported",
      400,
      "Only return=minimal and return=representation are supported.",
    );
  }
  if (
    values.some(
      (value) => value.startsWith("resolution=") && value !== "resolution=merge-duplicates",
    )
  ) {
    throw new GatewayError("unsupported", 400, "Only resolution=merge-duplicates is supported.");
  }
  const countExact = parseCountPreference(headers);
  return Object.freeze({
    returnRepresentation: returnValues[0] === "return=representation",
    countExact,
    mergeDuplicates: values.includes("resolution=merge-duplicates"),
  });
}

function parseIdempotencyKey(headers: Headers, compatibility: boolean): string {
  const key = headers.get("idempotency-key");
  if (key === null && compatibility) return `supabase-${crypto.randomUUID()}`;
  if (key === null || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) {
    throw new GatewayError("validation", 400, "A valid Idempotency-Key header is required.");
  }
  return key;
}

async function parseMutationRequest(
  request: Request,
  action: "insert" | "update" | "delete",
  manifest: SchemaManifest,
  tableName: string,
  context: TenantContext,
  maxRows: number,
  now: () => number,
  preference: MutationPreference,
  compatibility: boolean,
  maxRequestBytes: number,
): Promise<ParsedMutationRequest> {
  const url = new URL(request.url);
  const returnColumns = preference.returnRepresentation
    ? parseMutationReturnColumns(manifest, tableName, url.searchParams.get("select"))
    : null;
  const onConflict = url.searchParams.get("on_conflict");
  const columns = url.searchParams.get("columns");
  url.searchParams.delete("select");
  url.searchParams.delete("on_conflict");
  url.searchParams.delete("columns");
  const filterQuery = url.search;
  const upsert = action === "insert" && preference.mergeDuplicates;
  if (preference.mergeDuplicates && action !== "insert") {
    throw new GatewayError("unsupported", 400, "Merge resolution is supported only for upsert.");
  }
  if (
    (action === "update" || action === "delete") &&
    filterQuery.length === 0 &&
    !hasCapability(context, "data:bulk", now())
  ) {
    throw new GatewayError(
      "forbidden",
      403,
      "Unbounded mutations require the data:bulk capability.",
    );
  }
  if (action === "delete") {
    if (onConflict !== null || columns !== null) {
      throw new GatewayError("unsupported", 400, "Mutation query option is not supported.");
    }
    return Object.freeze({
      values: Object.freeze([]),
      filterQuery,
      upsert: false,
      returnColumns,
    });
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new GatewayError("validation", 400, "Mutations require Content-Type: application/json.");
  }
  const body = await readBoundedBody(request, maxRequestBytes);
  if (body.byteLength === 0) {
    throw new GatewayError(
      "validation",
      400,
      "Mutation payload must be a non-empty JSON document within 1MB.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new GatewayError("validation", 400, "Mutation payload must be valid JSON.");
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) {
    throw new GatewayError("validation", 400, "Mutation payload must not be empty.");
  }
  if (action === "update" && values.length !== 1) {
    throw new GatewayError(
      "unsupported",
      400,
      "PATCH accepts one JSON object; bulk updates use one payload and an explicit filter.",
    );
  }
  if (values.length > 1 && !hasCapability(context, "data:bulk", now())) {
    throw new GatewayError("forbidden", 403, "Bulk mutations require the data:bulk capability.");
  }
  if (values.length > maxRows) {
    throw new GatewayError("quota", 429, "Mutation row count exceeds the server cap.");
  }
  const normalized = values.map((value) => normalizeMutationInput(value));
  const table = requireTable(manifest, tableName);
  const primaryKey = primaryKeyColumns(table);
  if (compatibility) {
    validateSupabaseMutationQuery(
      action,
      upsert,
      filterQuery,
      onConflict,
      columns,
      normalized,
      primaryKey,
    );
  }
  if (upsert && primaryKey.length === 0) {
    throw new GatewayError("unsupported", 400, "Upsert requires a primary key.");
  }
  for (const input of normalized) {
    if (upsert) {
      const key = pickPrimaryKey(input, primaryKey);
      createMutationAst(manifest, "upsert", tableName, input, key);
    } else {
      createMutationAst(manifest, "insert", tableName, input);
    }
  }
  return Object.freeze({
    values: Object.freeze(normalized),
    filterQuery,
    upsert,
    returnColumns,
  });
}

function parseMutationReturnColumns(
  manifest: SchemaManifest,
  tableName: string,
  select: string | null,
): readonly string[] | null {
  if (select === null || select === "*") return null;
  const ast = parseQuery(manifest, tableName, `?select=${encodeURIComponent(select)}`);
  return ast.select.kind === "all" ? null : ast.select.columns;
}

function validateSupabaseMutationQuery(
  action: "insert" | "update" | "delete",
  upsert: boolean,
  filterQuery: string,
  onConflict: string | null,
  columns: string | null,
  values: readonly MutationInput[],
  primaryKey: readonly string[],
): void {
  if (action === "insert" && filterQuery.length > 0) {
    throw new GatewayError("unsupported", 400, "Insert filters are not supported.");
  }
  const filterParameters = new URLSearchParams(filterQuery);
  if (["order", "limit", "offset"].some((name) => filterParameters.has(name))) {
    throw new GatewayError("unsupported", 400, "Mutation ordering and pagination are unsupported.");
  }
  if (action !== "insert" && (onConflict !== null || columns !== null)) {
    throw new GatewayError("unsupported", 400, "Mutation query option is not supported.");
  }
  if (onConflict !== null && !upsert) {
    throw new GatewayError("unsupported", 400, "on_conflict requires merge upsert.");
  }
  if (onConflict !== null) {
    const conflictColumns = onConflict.split(",").map((column) => column.trim());
    if (
      conflictColumns.length !== primaryKey.length ||
      conflictColumns.some((column, index) => column !== primaryKey[index])
    ) {
      throw new GatewayError(
        "unsupported",
        400,
        "Only the complete primary key is supported as an upsert conflict target.",
      );
    }
  }
  const firstColumns = Object.keys(values[0] ?? {}).sort();
  if (values.some((value) => !sameStrings(Object.keys(value).sort(), firstColumns))) {
    throw new GatewayError("validation", 400, "All mutation object keys must match.");
  }
  if (columns !== null) {
    const declared = parseColumnsParameter(columns).sort();
    if (!sameStrings(declared, firstColumns)) {
      throw new GatewayError("validation", 400, "Mutation columns do not match the payload.");
    }
  }
}

function parseColumnsParameter(value: string): string[] {
  if (value.length === 0) throw new GatewayError("validation", 400, "columns must not be empty.");
  return value.split(",").map((column) => {
    const match = /^"([A-Za-z_][A-Za-z0-9_]*)"$/.exec(column);
    if (!match?.[1]) throw new GatewayError("validation", 400, "columns is invalid.");
    return match[1];
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function executeMutation(
  transaction: StorageExecutor,
  project: RestProject,
  context: TenantContext,
  action: "insert" | "update" | "delete",
  tableName: string,
  request: ParsedMutationRequest,
  returnRepresentation: boolean,
  countExact: boolean,
  returnColumns: readonly string[] | null,
  compatibility: boolean,
  maxRows: number,
  maxResponseBytes: number,
  transactionId: string,
  occurredAt: number,
): Readonly<{ response: MutationResponse; rowCount: number }> {
  const manifest = buildSchemaManifest(transaction);
  const table = requireTable(manifest, tableName);
  const primaryKey = primaryKeyColumns(table);
  const effectiveAction = request.upsert ? "upsert" : action;
  const affected =
    action === "insert"
      ? []
      : readAffectedRows(
          transaction,
          manifest,
          project.policies,
          context,
          action,
          tableName,
          request.filterQuery,
          maxRows,
        );
  const rows: Record<string, StorageValue>[] = [];
  const changes: PendingChange[] = [];

  if (effectiveAction === "insert" || effectiveAction === "upsert") {
    for (const input of request.values) {
      const key = effectiveAction === "upsert" ? pickPrimaryKey(input, primaryKey) : null;
      const oldRow = key === null ? null : readRowByPrimaryKey(transaction, table, key);
      if (oldRow === null) {
        assertPolicy(project.policies, manifest, context, "insert", tableName, undefined, input);
      } else {
        assertPolicy(project.policies, manifest, context, "update", tableName, oldRow, input);
      }
      const result = transaction.execute<Record<string, StorageValue>>(
        compileMutation(
          manifest,
          createMutationAst(manifest, effectiveAction, tableName, input, key),
        ),
      );
      rows.push(...result.rows);
      const record = result.rows[0];
      if (record === undefined) {
        throw new GatewayError("infrastructure", 503, "Mutation did not return its changed row.");
      }
      changes.push(
        Object.freeze({
          eventId: crypto.randomUUID(),
          operation: oldRow === null ? "INSERT" : "UPDATE",
          table: tableName,
          oldRecord:
            oldRow === null
              ? null
              : redactChangeRecord(manifest, project.policies, context, tableName, oldRow),
          record: redactChangeRecord(manifest, project.policies, context, tableName, record),
          policyOldRecord:
            oldRow === null ? null : snapshotChangeRecord(manifest, tableName, oldRow),
          policyRecord: snapshotChangeRecord(manifest, tableName, record),
        }),
      );
    }
  } else {
    for (const oldRow of affected) {
      const key = pickPrimaryKey(oldRow, primaryKey);
      if (action === "update") {
        const input = request.values[0];
        if (input === undefined) {
          throw new GatewayError("validation", 400, "Update payload is required.");
        }
        assertPolicy(project.policies, manifest, context, "update", tableName, oldRow, input);
        const changed = transaction.execute<Record<string, StorageValue>>(
          compileMutation(manifest, createMutationAst(manifest, "update", tableName, input, key)),
        ).rows[0];
        if (changed === undefined) {
          throw new GatewayError("infrastructure", 503, "Mutation did not return its changed row.");
        }
        rows.push(changed);
        changes.push(
          Object.freeze({
            eventId: crypto.randomUUID(),
            operation: "UPDATE",
            table: tableName,
            oldRecord: redactChangeRecord(manifest, project.policies, context, tableName, oldRow),
            record: redactChangeRecord(manifest, project.policies, context, tableName, changed),
            policyOldRecord: snapshotChangeRecord(manifest, tableName, oldRow),
            policyRecord: snapshotChangeRecord(manifest, tableName, changed),
          }),
        );
      } else {
        assertPolicy(project.policies, manifest, context, "delete", tableName, oldRow, undefined);
        const deleted = transaction.execute<Record<string, StorageValue>>(
          compileMutation(manifest, createMutationAst(manifest, "delete", tableName, {}, key)),
        ).rows[0];
        if (deleted === undefined) {
          throw new GatewayError("infrastructure", 503, "Mutation did not return its changed row.");
        }
        rows.push(deleted);
        changes.push(
          Object.freeze({
            eventId: crypto.randomUUID(),
            operation: "DELETE",
            table: tableName,
            oldRecord: redactChangeRecord(manifest, project.policies, context, tableName, oldRow),
            record: null,
            policyOldRecord: snapshotChangeRecord(manifest, tableName, oldRow),
            policyRecord: null,
          }),
        );
      }
    }
  }

  if (changes.length > 0) {
    appendChangeEvents(transaction, {
      tenant: context.tenant,
      transactionId,
      occurredAt,
      changes,
    });
  }

  const body = returnRepresentation
    ? JSON.stringify(
        projectMutationRows(manifest, project.policies, context, tableName, rows, returnColumns),
      )
    : null;
  if (body !== null && new TextEncoder().encode(body).byteLength > maxResponseBytes) {
    throw new GatewayError("quota", 413, "Response size limit exceeded.");
  }
  const status = returnRepresentation
    ? action === "insert"
      ? 201
      : 200
    : compatibility && action === "insert"
      ? 201
      : 204;
  const appliedPreferences = [
    returnRepresentation ? "return=representation" : "return=minimal",
    ...(countExact ? ["count=exact"] : []),
    ...(request.upsert ? ["resolution=merge-duplicates"] : []),
  ];
  return Object.freeze({
    rowCount: rows.length,
    response: Object.freeze({
      status,
      body,
      headers: Object.freeze({
        ...(compatibility || countExact
          ? { "content-range": countExact ? `*/${rows.length}` : "*/*" }
          : {}),
        ...(returnRepresentation
          ? {
              "content-type": "application/json; charset=utf-8",
              "preference-applied": appliedPreferences.join(", "),
            }
          : { "preference-applied": appliedPreferences.join(", ") }),
      }),
    }),
  });
}

function redactChangeRecord(
  manifest: SchemaManifest,
  policies: PolicyDocument,
  context: TenantContext,
  table: string,
  row: Readonly<Record<string, StorageValue>>,
): ChangeRecord {
  const decision = simulatePolicy(manifest, policies, { context, action: "select", table, row });
  return Object.freeze(
    Object.fromEntries(
      decision.allowedFields.map((field) => [field, serializeChangeValue(row[field] ?? null)]),
    ),
  );
}

function snapshotChangeRecord(
  manifest: SchemaManifest,
  tableName: string,
  row: Readonly<Record<string, StorageValue>>,
): ChangeRecord {
  const table = requireTable(manifest, tableName);
  return Object.freeze(
    Object.fromEntries(
      table.columns
        .filter((column) => column.hidden === "none")
        .map((column) => [column.name, serializeChangeValue(row[column.name] ?? null)]),
    ),
  );
}

function serializeChangeValue(value: StorageValue): string | number | null {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return value;
}

function readAffectedRows(
  transaction: StorageExecutor,
  manifest: SchemaManifest,
  policies: PolicyDocument,
  context: TenantContext,
  action: "update" | "delete",
  tableName: string,
  filterQuery: string,
  maxRows: number,
): readonly Record<string, StorageValue>[] {
  const ast = parseQuery(manifest, tableName, filterQuery);
  const rewritten = rewritePolicyQuery(
    manifest,
    policies,
    context,
    action,
    Object.freeze({ ...ast, limit: maxRows + 1, offset: 0, order: Object.freeze([]) }),
  );
  const rows = transaction.execute<Record<string, StorageValue>>(
    compileSelect(manifest, rewritten.ast),
  ).rows;
  if (rows.length > maxRows) {
    throw new GatewayError("quota", 429, "Affected row count exceeds the server cap.");
  }
  return rows;
}

function readRowByPrimaryKey(
  transaction: StorageExecutor,
  table: SchemaTable,
  key: MutationInput,
): Record<string, StorageValue> | null {
  const columns = Object.keys(key);
  const result = transaction.execute<Record<string, StorageValue>>({
    sql: `SELECT * FROM ${quoteIdentifier(table.name)} WHERE ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(" AND ")}`,
    parameters: columns.map((column) => key[column] ?? null),
  });
  return result.rows[0] ?? null;
}

function assertPolicy(
  policies: PolicyDocument,
  manifest: SchemaManifest,
  context: TenantContext,
  action: "insert" | "update" | "delete",
  table: string,
  row: Record<string, StorageValue> | undefined,
  input: MutationInput | undefined,
): void {
  const decision = simulatePolicy(manifest, policies, {
    context,
    action,
    table,
    ...(row === undefined ? {} : { row }),
    ...(input === undefined ? {} : { input, fields: Object.keys(input) }),
  });
  if (!decision.allowed) {
    throw new GatewayError("forbidden", 403, "Mutation was denied by policy.");
  }
}

function projectMutationRows(
  manifest: SchemaManifest,
  policies: PolicyDocument,
  context: TenantContext,
  table: string,
  rows: readonly Record<string, StorageValue>[],
  requestedColumns: readonly string[] | null,
): readonly Record<string, StorageValue>[] {
  return rows.map((row) => {
    const decision = simulatePolicy(manifest, policies, { context, action: "select", table, row });
    if (decision.allowedFields.length === 0) {
      throw new GatewayError("forbidden", 403, "Mutation representation is denied by policy.");
    }
    const columns = requestedColumns ?? decision.allowedFields;
    if (columns.some((column) => !decision.allowedFields.includes(column))) {
      throw new GatewayError("forbidden", 403, "Mutation representation is denied by policy.");
    }
    return Object.freeze(Object.fromEntries(columns.map((field) => [field, row[field] ?? null])));
  });
}

function normalizeMutationInput(value: unknown): MutationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayError("validation", 400, "Each mutation row must be a JSON object.");
  }
  const input: Record<string, string | number | null> = {};
  for (const [column, field] of Object.entries(value)) {
    if (typeof field !== "string" && typeof field !== "number" && field !== null) {
      throw new GatewayError(
        "validation",
        400,
        "Mutation values must be strings, numbers or null.",
      );
    }
    if (typeof field === "number" && !Number.isFinite(field)) {
      throw new GatewayError("validation", 400, "Mutation numbers must be finite.");
    }
    input[column] = field;
  }
  return Object.freeze(input);
}

function requireTable(manifest: SchemaManifest, tableName: string): SchemaTable {
  const table = manifest.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) {
    throw new GatewayError("validation", 400, "Table is not exposed by the schema manifest.");
  }
  return table;
}

function primaryKeyColumns(table: SchemaTable): readonly string[] {
  return Object.freeze(
    table.columns
      .filter((column) => column.primaryKeyPosition > 0 && column.hidden === "none")
      .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
      .map((column) => column.name),
  );
}

function pickPrimaryKey(
  values: Readonly<Record<string, StorageValue>>,
  columns: readonly string[],
): MutationInput {
  const key: Record<string, string | number | null> = {};
  for (const column of columns) {
    const value = values[column];
    if (
      value === undefined ||
      value === null ||
      (typeof value !== "string" && typeof value !== "number")
    ) {
      throw new GatewayError(
        "validation",
        400,
        "Mutation requires all non-null primary key columns.",
      );
    }
    key[column] = value;
  }
  return Object.freeze(key);
}

function createIdempotencyTable(transaction: StorageExecutor): void {
  transaction.execute({
    sql: "CREATE TABLE IF NOT EXISTS _mekka_idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT, headers TEXT NOT NULL, PRIMARY KEY (scope, key))",
  });
}

function createIdempotencyScope(context: TenantContext): string {
  return [
    context.tenant.organizationId,
    context.tenant.projectId,
    context.tenant.environmentId,
    context.tenant.branchId,
    context.tenant.generation,
    context.actor.kind,
    context.actor.id,
  ].join(":");
}

function readIdempotency(
  transaction: StorageExecutor,
  scope: string,
  key: string,
): Readonly<{ fingerprint: string; response: MutationResponse }> | null {
  const row = transaction.execute<{
    fingerprint: StorageValue;
    status: StorageValue;
    body: StorageValue;
    headers: StorageValue;
  }>({
    sql: "SELECT fingerprint, status, body, headers FROM _mekka_idempotency WHERE scope = ? AND key = ?",
    parameters: [scope, key],
  }).rows[0];
  if (row === undefined) {
    return null;
  }
  if (
    typeof row.fingerprint !== "string" ||
    typeof row.status !== "number" ||
    (typeof row.body !== "string" && row.body !== null) ||
    typeof row.headers !== "string"
  ) {
    throw new GatewayError("infrastructure", 503, "Idempotency record is invalid.");
  }
  const headers = parseStoredHeaders(row.headers);
  return Object.freeze({
    fingerprint: row.fingerprint,
    response: Object.freeze({ status: row.status, body: row.body, headers }),
  });
}

function writeIdempotency(
  transaction: StorageExecutor,
  scope: string,
  key: string,
  fingerprint: string,
  response: MutationResponse,
): void {
  transaction.execute({
    sql: "INSERT INTO _mekka_idempotency (scope, key, fingerprint, status, body, headers) VALUES (?, ?, ?, ?, ?, ?)",
    parameters: [
      scope,
      key,
      fingerprint,
      response.status,
      response.body,
      JSON.stringify(response.headers),
    ],
  });
}

function parseStoredHeaders(value: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((entry) => typeof entry !== "string")
    ) {
      throw new Error("Invalid headers.");
    }
    return Object.freeze({ ...(parsed as Record<string, string>) });
  } catch {
    throw new GatewayError("infrastructure", 503, "Idempotency record is invalid.");
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function applyRange(
  ast: ReturnType<typeof parseQuery>,
  headers: Headers,
  maxRows: number,
): ReturnType<typeof parseQuery> {
  const range = headers.get("range");
  const rangeUnit = headers.get("range-unit");
  if (range === null) {
    if (rangeUnit !== null && rangeUnit !== "items") {
      throw new GatewayError("validation", 400, "Range-Unit must be items.");
    }
    if (ast.limit !== null && ast.limit > maxRows) {
      throw new GatewayError("quota", 429, "Requested row limit exceeds the server cap.");
    }
    return Object.freeze({ ...ast, limit: ast.limit ?? maxRows });
  }
  if (rangeUnit !== "items") {
    throw new GatewayError("validation", 400, "Range requests require Range-Unit: items.");
  }
  if (ast.limit !== null || ast.offset !== 0) {
    throw new GatewayError(
      "validation",
      400,
      "Range headers cannot be combined with limit or offset.",
    );
  }

  const match = /^(\d+)-(\d+)?$/.exec(range);
  if (match === null) {
    throw new GatewayError("validation", 400, "Range must use items=start-end.");
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start + maxRows - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new GatewayError("validation", 400, "Range must use valid non-negative item indexes.");
  }
  const limit = end - start + 1;
  if (limit > maxRows) {
    throw new GatewayError("quota", 429, "Requested row limit exceeds the server cap.");
  }
  return Object.freeze({ ...ast, limit, offset: start });
}

function parseCountPreference(headers: Headers): boolean {
  const preference = headers.get("prefer");
  if (preference === null) {
    return false;
  }
  const values = preference.split(",").map((value) => value.trim());
  if (values.includes("count=exact")) {
    return true;
  }
  if (values.some((value) => value.startsWith("count="))) {
    throw new GatewayError("unsupported", 400, "Only Prefer: count=exact is supported.");
  }
  return false;
}

function createContentRange(offset: number, count: number, total: number | null): string {
  const denominator = total === null ? "*" : String(total);
  if (count === 0) {
    return `*/${denominator}`;
  }
  return `${offset}-${offset + count - 1}/${denominator}`;
}

function readExactCount(result: StorageResult): number {
  const value = result.rows[0]?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError("infrastructure", 503, "Count query returned an invalid result.");
  }
  return value;
}

function toErrorResponse(error: unknown, headers: Headers, compatibility = false): Response {
  const correlationId = safeCorrelationId(headers);
  const gatewayError = toGatewayError(error);
  return Response.json(
    compatibility
      ? createSupabaseErrorBody(gatewayError.code)
      : createErrorEnvelope(gatewayError.code, correlationId),
    {
      status: gatewayError.status,
      headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
    },
  );
}

function fallbackErrorResponse(status: 404 | 500, headers: Headers): Response {
  const correlationId = safeCorrelationId(headers);
  return Response.json(
    createErrorEnvelope(status === 404 ? "validation" : "infrastructure", correlationId),
    {
      status,
      headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
    },
  );
}

function validateContentLength(headers: Headers, maxBytes: number): number | null {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new GatewayError("validation", 400, "Content-Length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new GatewayError("validation", 400, "Content-Length is invalid.");
  }
  if (length > maxBytes) {
    throw new GatewayError("quota", 413, "Request payload size limit exceeded.");
  }
  return length;
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = validateContentLength(request.headers, maxBytes);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayError("quota", 413, "Request payload size limit exceeded.");
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && declaredLength !== total) {
    throw new GatewayError("validation", 400, "Content-Length does not match the request body.");
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function recordMetricSafely(dependencies: GatewayDependencies, metric: GatewayMetric): void {
  try {
    void Promise.resolve(dependencies.recordMetric(metric)).catch(() => undefined);
  } catch {
    // Telemetry failures must not alter the client response.
  }
}

function safeCorrelationId(headers: Headers): TenantContext["correlationId"] {
  return resolveCorrelationId(headers);
}

function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }
  if (error instanceof RestQueryTimeoutError) {
    return new GatewayError("infrastructure", 503, error.message);
  }
  if (error instanceof PolicyError) {
    return new GatewayError(
      error.code === "POLICY_FORBIDDEN" ? "forbidden" : "infrastructure",
      error.code === "POLICY_FORBIDDEN" ? 403 : 503,
      error.message,
    );
  }
  if (error instanceof QueryAstError || error instanceof ProtocolError) {
    if (error instanceof ProtocolError) {
      return new GatewayError(error.code, statusForProtocolCode(error.code), error.message);
    }
    return new GatewayError(
      error.code === "QUERY_AST_UNSUPPORTED" ? "unsupported" : "validation",
      400,
      error.message,
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  ) {
    return new GatewayError("conflict", 409, "SQLite constraint conflict.");
  }
  return new GatewayError("infrastructure", 503, "Request processing failed.");
}

function metricOutcome(status: number, error: unknown): GatewayMetric["outcome"] {
  if (error instanceof RestQueryTimeoutError) {
    return "timeout";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return status >= 500 ? "infrastructure_error" : "client_error";
}

function resolveLimits(overrides: Partial<GatewayLimits> | undefined): GatewayLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Gateway limit ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(limits);
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

class GatewayError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function statusForProtocolCode(code: ErrorCode): number {
  switch (code) {
    case "auth":
      return 401;
    case "forbidden":
      return 403;
    case "quota":
      return 429;
    case "unsupported":
      return 501;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "infrastructure":
      return 503;
    case "validation":
      return 400;
  }
}
