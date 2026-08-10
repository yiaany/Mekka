import {
  type CorrelationId,
  createCorrelationId,
  type ErrorCode,
  parseCorrelationId,
  parseTenantIdentity,
  serializeTenantIdentity,
  type TenantIdentity,
  type TenantIdentityInput,
  tenantHeaders,
} from "@mekka/protocol";

export * from "./storage";

const maxResponseBytes = 2 * 1024 * 1024;
const defaultMutationTimeoutMs = 10_000;

export type StudioMutationOptions = Readonly<{ signal?: AbortSignal }>;

export type StudioCredential =
  | Readonly<{ kind: "session"; token: string }>
  | Readonly<{ kind: "publishable"; key: string }>;

export type StudioTable = Readonly<{
  id: string;
  name: string;
  namespace: "main";
  kind: "table";
  columnCount: number;
  primaryKey: readonly string[];
}>;

export type StudioTablePage = Readonly<{
  tables: readonly StudioTable[];
  totalCount: number;
}>;

export type StudioColumnType = "INTEGER" | "TEXT" | "REAL" | "BLOB" | "NUMERIC";
export type StudioTableColumn = Readonly<{
  name: string;
  type: StudioColumnType;
  nullable: boolean;
  primaryKey: boolean;
}>;
export type StudioTableDefinition = Readonly<{
  name: string;
  columns: readonly StudioTableColumn[];
  primaryKey: readonly string[];
}>;
export type StudioSchemaMutation<T> = Readonly<{
  resource: T;
  migrationSql: string;
  checkpointId: string | null;
}>;

export type StudioSchemaHealth = Readonly<{
  status: "ok";
  formatVersion: number;
  schemaVersion: number;
  schemaHash: string;
}>;

export type StudioRowValue = string | number | null;
export type StudioRow = Readonly<Record<string, StudioRowValue>>;
export type StudioRowsPage = Readonly<{
  rows: readonly StudioRow[];
  totalCount: number;
  limit: number;
  offset: number;
}>;
export type StudioSqlResult = Readonly<{
  rows: readonly StudioRow[];
  changes: number;
}>;

export type StudioDomainClient = Readonly<{
  listTables(
    input?: Readonly<{
      search?: string;
      sort?: "alphabetical" | "grouped-alphabetical";
      limit?: number;
      page?: number;
      signal?: AbortSignal;
    }>,
  ): Promise<StudioTablePage>;
  getSchemaHealth(input?: Readonly<{ signal?: AbortSignal }>): Promise<StudioSchemaHealth>;
  getTable(
    name: string,
    input?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<StudioTableDefinition>;
  createTable(
    input: Readonly<{
      name: string;
      columns: readonly StudioTableColumn[];
      expectedSchemaHash: string;
    }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<StudioSchemaMutation<StudioTableDefinition>>;
  renameTable(
    input: Readonly<{ table: string; name: string; expectedSchemaHash: string }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<StudioSchemaMutation<StudioTableDefinition>>;
  deleteTable(
    input: Readonly<{ table: string; expectedSchemaHash: string }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<StudioSchemaMutation<StudioTableDefinition>>;
  addColumn(
    input: Readonly<{
      table: string;
      column: Omit<StudioTableColumn, "primaryKey">;
      expectedSchemaHash: string;
    }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<StudioSchemaMutation<StudioTableDefinition>>;
  renameColumn(
    input: Readonly<{ table: string; column: string; name: string; expectedSchemaHash: string }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<StudioSchemaMutation<StudioTableDefinition>>;
  listRows(
    table: string,
    input?: Readonly<{
      limit?: number;
      offset?: number;
      filter?: Readonly<{ column: string; value: string }>;
      signal?: AbortSignal;
    }>,
  ): Promise<StudioRowsPage>;
  createRow(
    table: string,
    values: StudioRow,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<Readonly<{ changes: number }>>;
  updateRow(
    table: string,
    key: Readonly<{ column: string; value: StudioRowValue }>,
    values: StudioRow,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<Readonly<{ changes: number }>>;
  deleteRow(
    table: string,
    key: Readonly<{ column: string; value: string }>,
    idempotencyKey: string,
    options?: StudioMutationOptions,
  ): Promise<Readonly<{ changes: number }>>;
  runSql(
    input: Readonly<{ sql: string; signal?: AbortSignal }>,
    idempotencyKey: string,
  ): Promise<StudioSqlResult>;
}>;

export type StudioAuthUser = Readonly<{
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}>;
export type StudioAuthUserPage = Readonly<{
  users: readonly StudioAuthUser[];
  totalCount: number;
  limit: number;
  offset: number;
}>;
export type StudioAuthSession = Readonly<{
  id: string;
  createdAt: string;
  expiresAt: string;
}>;
export type StudioAuthUserDetail = Readonly<{
  user: Omit<StudioAuthUser, "updatedAt" | "sessionCount">;
  sessions: readonly StudioAuthSession[];
}>;
export type StudioAuthProvider = "google" | "github";
export type StudioAuthProviderSetting = Readonly<{
  provider: StudioAuthProvider;
  enabled: boolean;
  clientIdConfigured: boolean;
  clientSecretConfigured: boolean;
}>;
export type StudioAuthTemplate = "email-verification" | "password-reset";
export type StudioAuthTemplateSetting = Readonly<{
  template: StudioAuthTemplate;
  subject: string;
  text: string;
}>;
export type StudioAuthSettings = Readonly<{
  providers: readonly StudioAuthProviderSetting[];
  redirectUrls: readonly string[];
  templates: readonly StudioAuthTemplateSetting[];
}>;
export type StudioAuthAdminClient = Readonly<{
  listUsers(
    input?: Readonly<{ query?: string; limit?: number; offset?: number; signal?: AbortSignal }>,
  ): Promise<StudioAuthUserPage>;
  getUser(
    userId: string,
    input?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<StudioAuthUserDetail>;
  getSettings(input?: Readonly<{ signal?: AbortSignal }>): Promise<StudioAuthSettings>;
  revokeUser(
    userId: string,
    confirmation: string,
    idempotencyKey: string,
  ): Promise<Readonly<{ revoked: true }>>;
  updateProvider(
    provider: StudioAuthProvider,
    input: Readonly<{ enabled: boolean; clientId?: string; clientSecret?: string }>,
    idempotencyKey: string,
  ): Promise<StudioAuthProviderSetting>;
  updateRedirectUrls(
    urls: readonly string[],
    idempotencyKey: string,
  ): Promise<Readonly<{ urls: readonly string[] }>>;
  updateTemplate(
    template: StudioAuthTemplate,
    input: Readonly<{ subject: string; text: string }>,
    idempotencyKey: string,
  ): Promise<StudioAuthTemplateSetting>;
}>;

export type StudioOnboardingStatus = "provisioning" | "ready" | "failed";
export type StudioOnboardingPhase =
  | "catalog"
  | "database"
  | "credentials"
  | "health"
  | "cleanup"
  | "complete";
export type StudioOnboardingModule = "auth" | "storage" | "realtime" | "functions";
export type StudioOnboardingTemplate =
  | "empty"
  | "saas"
  | "marketplace"
  | "chat"
  | "mobile"
  | "import";
export type StudioOnboardingRequest = Readonly<{
  organizationName: string;
  projectName: string;
  region: "us-east-1" | "us-west-2" | "eu-central-1";
  template: StudioOnboardingTemplate;
  enabledModules: readonly StudioOnboardingModule[];
}>;
export type StudioOnboarding = Readonly<{
  id: string;
  projectId: string;
  status: StudioOnboardingStatus;
  phase: StudioOnboardingPhase;
  errorCode: ErrorCode | null;
  connection: Readonly<{ apiUrl: string; publishableKey: string }> | null;
}>;
export type StudioOnboardingClient = Readonly<{
  create(input: StudioOnboardingRequest, idempotencyKey: string): Promise<StudioOnboarding>;
  retry(id: string, idempotencyKey: string): Promise<StudioOnboarding>;
}>;

export class StudioDomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly correlationId: CorrelationId,
    message = errorMessage(code),
    readonly outcomeAmbiguous = false,
  ) {
    super(message);
    this.name = "StudioDomainError";
  }
}

export function isStudioDomainError(error: unknown): error is StudioDomainError {
  return error instanceof StudioDomainError;
}

export function isStudioMutationOutcomeAmbiguous(error: unknown): boolean {
  return error instanceof StudioDomainError && error.outcomeAmbiguous;
}

export function createStudioDomainClient(
  input: Readonly<{
    baseUrl: string;
    tenant: TenantIdentity | TenantIdentityInput;
    getCredential?: () => Promise<StudioCredential | undefined> | StudioCredential | undefined;
    fetch?: typeof globalThis.fetch;
    mutationTimeoutMs?: number;
  }>,
): StudioDomainClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const tenant = parseTenantIdentity(input.tenant);
  const fetcher = input.fetch ?? globalThis.fetch;
  const mutationTimeoutMs = readMutationTimeout(input.mutationTimeoutMs);

  return Object.freeze({
    async listTables(options = {}) {
      const rawTables = parseTables(
        await request(fetcher, baseUrl, tenant, input.getCredential, "tables", options.signal),
      );
      const search = options.search?.trim().toLocaleLowerCase() ?? "";
      const filtered = rawTables
        .filter((table) => search.length === 0 || table.name.toLocaleLowerCase().includes(search))
        .sort((left, right) => left.name.localeCompare(right.name));
      const limit = boundedInteger(options.limit, 100, 1, 200);
      const page = boundedInteger(options.page, 0, 0, Number.MAX_SAFE_INTEGER);
      const start = page * limit;
      return Object.freeze({
        tables: Object.freeze(filtered.slice(start, start + limit)),
        totalCount: filtered.length,
      });
    },
    async getSchemaHealth(options = {}) {
      return parseSchemaHealth(
        await request(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          "schema/health",
          options.signal,
        ),
      );
    },
    async getTable(name, options = {}) {
      assertIdentifier(name);
      return parseTableDefinition(
        await request(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `tables/${encodeURIComponent(name)}`,
          options.signal,
        ),
      );
    },
    async createTable(payload, idempotencyKey, options = {}) {
      validateCreateTable(payload);
      return parseMutation(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          "tables",
          "POST",
          payload,
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async renameTable(payload, idempotencyKey, options = {}) {
      assertIdentifier(payload.table);
      assertCreatableIdentifier(payload.name);
      assertSchemaHash(payload.expectedSchemaHash);
      return parseMutation(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `tables/${encodeURIComponent(payload.table)}`,
          "PATCH",
          { name: payload.name, expectedSchemaHash: payload.expectedSchemaHash },
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async deleteTable(payload, idempotencyKey, options = {}) {
      assertIdentifier(payload.table);
      assertSchemaHash(payload.expectedSchemaHash);
      return parseMutation(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `tables/${encodeURIComponent(payload.table)}?expected_schema_hash=${payload.expectedSchemaHash}`,
          "DELETE",
          undefined,
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async addColumn(payload, idempotencyKey, options = {}) {
      assertIdentifier(payload.table);
      validateColumn(payload.column, false);
      assertSchemaHash(payload.expectedSchemaHash);
      return parseMutation(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          "columns",
          "POST",
          {
            table: payload.table,
            ...payload.column,
            expectedSchemaHash: payload.expectedSchemaHash,
          },
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async renameColumn(payload, idempotencyKey, options = {}) {
      assertIdentifier(payload.table);
      assertIdentifier(payload.column);
      assertCreatableIdentifier(payload.name);
      assertSchemaHash(payload.expectedSchemaHash);
      return parseMutation(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `columns/${encodeURIComponent(payload.table)}/${encodeURIComponent(payload.column)}`,
          "PATCH",
          { name: payload.name, expectedSchemaHash: payload.expectedSchemaHash },
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async listRows(table, options = {}) {
      assertIdentifier(table);
      const limit = boundedInteger(options.limit, 50, 1, 200);
      const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (options.filter !== undefined) {
        assertIdentifier(options.filter.column);
        if (options.filter.value.length > 16_384) {
          throw new StudioDomainError("validation", 400, createCorrelationId());
        }
        search.set("filter_column", options.filter.column);
        search.set("filter_value", options.filter.value);
      }
      return parseRowsPage(
        await request(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `rows/${encodeURIComponent(table)}?${search.toString()}`,
          options.signal,
        ),
      );
    },
    async createRow(table, values, idempotencyKey, options = {}) {
      assertIdentifier(table);
      validateRow(values, false);
      return parseChanges(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `rows/${encodeURIComponent(table)}`,
          "POST",
          { values },
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async updateRow(table, key, values, idempotencyKey, options = {}) {
      assertIdentifier(table);
      assertIdentifier(key.column);
      validateRowValue(key.value);
      validateRow(values, true);
      return parseChanges(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `rows/${encodeURIComponent(table)}`,
          "PATCH",
          { key, values },
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async deleteRow(table, key, idempotencyKey, options = {}) {
      assertIdentifier(table);
      assertIdentifier(key.column);
      if (key.value.length > 16_384)
        throw new StudioDomainError("validation", 400, createCorrelationId());
      return parseChanges(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          `rows/${encodeURIComponent(table)}?key_column=${encodeURIComponent(key.column)}&key_value=${encodeURIComponent(key.value)}`,
          "DELETE",
          undefined,
          idempotencyKey,
          options.signal,
          mutationTimeoutMs,
        ),
      );
    },
    async runSql(payload, idempotencyKey) {
      validateSql(payload.sql);
      return parseSqlResult(
        await mutationRequest(
          fetcher,
          baseUrl,
          tenant,
          input.getCredential,
          "sql",
          "POST",
          { sql: payload.sql },
          idempotencyKey,
          payload.signal,
          mutationTimeoutMs,
        ),
      );
    },
  });
}

export function createStudioAuthAdminClient(
  input: Readonly<{
    baseUrl: string;
    tenant: TenantIdentity | TenantIdentityInput;
    getCredential?: () =>
      | Promise<Extract<StudioCredential, { kind: "session" }> | undefined>
      | Extract<StudioCredential, { kind: "session" }>
      | undefined;
    getCsrfToken: () => Promise<string> | string;
    fetch?: typeof globalThis.fetch;
  }>,
): StudioAuthAdminClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const tenant = parseTenantIdentity(input.tenant);
  const fetcher = input.fetch ?? globalThis.fetch;
  const authRequest = async (
    path: string,
    method: "GET" | "POST" | "PUT",
    payload?: unknown,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) => {
    let mutationHeaders: Readonly<Record<string, string>> = {};
    if (method !== "GET") {
      const csrfToken = await input.getCsrfToken();
      if (!/^[A-Za-z0-9_-]{24,256}$/.test(csrfToken)) {
        throw new StudioDomainError("auth", 401, createCorrelationId());
      }
      mutationHeaders = { "x-mekka-csrf-token": csrfToken };
    }
    return requestWithMethod(
      fetcher,
      baseUrl,
      tenant,
      input.getCredential,
      path,
      method,
      payload,
      signal,
      idempotencyKey,
      mutationHeaders,
    );
  };
  return Object.freeze({
    async listUsers(options = {}) {
      const query = options.query?.trim() ?? "";
      if (query.length > 128) throw new StudioDomainError("validation", 400, createCorrelationId());
      const limit = boundedInteger(options.limit, 50, 1, 100);
      const offset = boundedInteger(options.offset, 0, 0, 10_000);
      const search = new URLSearchParams({ query, limit: String(limit), offset: String(offset) });
      return parseAuthUserPage(
        await authRequest(`users?${search}`, "GET", undefined, undefined, options.signal),
      );
    },
    async getUser(userId, options = {}) {
      assertResourceId(userId);
      return parseAuthUserDetail(
        await authRequest(
          `users/${encodeURIComponent(userId)}`,
          "GET",
          undefined,
          undefined,
          options.signal,
        ),
      );
    },
    async getSettings(options = {}) {
      return parseAuthSettings(
        await authRequest("settings", "GET", undefined, undefined, options.signal),
      );
    },
    async revokeUser(userId, confirmation, idempotencyKey) {
      assertResourceId(userId);
      assertIdempotencyKey(idempotencyKey);
      const record = readRecord(
        await authRequest(
          `users/${encodeURIComponent(userId)}/revoke`,
          "POST",
          { confirmation },
          idempotencyKey,
        ),
      );
      if (record.revoked !== true) throw malformedResponse();
      return Object.freeze({ revoked: true as const });
    },
    async updateProvider(provider, update, idempotencyKey) {
      readOneOf(provider, ["google", "github"] as const);
      assertIdempotencyKey(idempotencyKey);
      if (typeof update.enabled !== "boolean")
        throw new StudioDomainError("validation", 400, createCorrelationId());
      for (const secret of [update.clientId, update.clientSecret]) {
        if (secret !== undefined && (secret.trim().length < 3 || secret.length > 4096)) {
          throw new StudioDomainError("validation", 400, createCorrelationId());
        }
      }
      return parseAuthProviderSetting({
        provider,
        ...readRecord(await authRequest(`providers/${provider}`, "PUT", update, idempotencyKey)),
      });
    },
    async updateRedirectUrls(urls, idempotencyKey) {
      assertIdempotencyKey(idempotencyKey);
      if (!Array.isArray(urls) || urls.length > 32)
        throw new StudioDomainError("validation", 400, createCorrelationId());
      return Object.freeze({
        urls: parseRedirectUrls(
          readRecord(await authRequest("redirects", "PUT", { urls }, idempotencyKey)).urls,
        ),
      });
    },
    async updateTemplate(template, update, idempotencyKey) {
      readOneOf(template, ["email-verification", "password-reset"] as const);
      assertIdempotencyKey(idempotencyKey);
      return parseAuthTemplateSetting(
        await authRequest(`templates/${template}`, "PUT", update, idempotencyKey),
      );
    },
  });
}

export function createStudioOnboardingClient(
  input: Readonly<{
    baseUrl: string;
    getCredential?: () =>
      | Promise<Extract<StudioCredential, { kind: "session" }> | undefined>
      | Extract<StudioCredential, { kind: "session" }>
      | undefined;
    fetch?: typeof globalThis.fetch;
  }>,
): StudioOnboardingClient {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const fetcher = input.fetch ?? globalThis.fetch;
  return Object.freeze({
    create: (request, idempotencyKey) =>
      onboardingRequest(
        fetcher,
        baseUrl,
        input.getCredential,
        "onboarding",
        "POST",
        request,
        idempotencyKey,
      ),
    retry: (id, idempotencyKey) => {
      if (!/^[A-Za-z0-9_-]{3,128}$/.test(id)) {
        throw new StudioDomainError("validation", 400, createCorrelationId());
      }
      return onboardingRequest(
        fetcher,
        baseUrl,
        input.getCredential,
        `onboarding/${id}/retry`,
        "POST",
        undefined,
        idempotencyKey,
      );
    },
  });
}

async function request(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  tenant: TenantIdentity,
  getCredential:
    | (() => Promise<StudioCredential | undefined> | StudioCredential | undefined)
    | undefined,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return requestWithMethod(fetcher, baseUrl, tenant, getCredential, path, "GET", undefined, signal);
}

async function mutationRequest(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  tenant: TenantIdentity,
  getCredential:
    | (() => Promise<StudioCredential | undefined> | StudioCredential | undefined)
    | undefined,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  payload: unknown,
  idempotencyKey: string,
  signal?: AbortSignal,
  timeoutMs = defaultMutationTimeoutMs,
): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  let rejectOnAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const rejectAborted = () =>
    rejectOnAbort?.(
      controller.signal.reason ?? new DOMException("Studio mutation cancelled", "AbortError"),
    );
  if (controller.signal.aborted) rejectAborted();
  else controller.signal.addEventListener("abort", rejectAborted, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Studio mutation timed out", "TimeoutError"));
  }, timeoutMs);
  try {
    return await Promise.race([
      requestWithMethod(
        fetcher,
        baseUrl,
        tenant,
        getCredential,
        path,
        method,
        payload,
        controller.signal,
        idempotencyKey,
        undefined,
        true,
      ),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) {
      throw new StudioDomainError(
        "infrastructure",
        504,
        createCorrelationId(),
        "The mutation timed out. Its outcome is not yet confirmed.",
        true,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", rejectAborted);
  }
}

async function requestWithMethod(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  tenant: TenantIdentity,
  getCredential:
    | (() => Promise<StudioCredential | undefined> | StudioCredential | undefined)
    | undefined,
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  payload: unknown,
  signal: AbortSignal | undefined,
  idempotencyKey?: string,
  additionalHeaders?: Readonly<Record<string, string>>,
  transportFailureIsAmbiguous = false,
): Promise<unknown> {
  const serialized = serializeTenantIdentity(tenant);
  const correlationId = createCorrelationId();
  const headers = new Headers({
    accept: "application/json",
    [tenantHeaders.organizationId]: serialized.organizationId,
    [tenantHeaders.projectId]: serialized.projectId,
    [tenantHeaders.environmentId]: serialized.environmentId,
    [tenantHeaders.branchId]: serialized.branchId,
    [tenantHeaders.generation]: String(serialized.generation),
    [tenantHeaders.correlationId]: correlationId,
  });
  if (payload !== undefined) headers.set("content-type", "application/json");
  if (idempotencyKey !== undefined) headers.set("idempotency-key", idempotencyKey);
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) headers.set(name, value);
  const credential = await getCredential?.();
  if (credential !== undefined) {
    const value = readCredential(credential);
    headers.set(credential.kind === "session" ? "authorization" : "x-mekka-publishable-key", value);
  }

  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/${path}`, {
      method,
      credentials: "include",
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw error;
    throw new StudioDomainError(
      "infrastructure",
      503,
      correlationId,
      errorMessage("infrastructure"),
      transportFailureIsAmbiguous,
    );
  }

  let body: unknown;
  try {
    body = await readJson(response, correlationId);
  } catch (error) {
    if (signal?.aborted === true || isAbortError(error)) throw error;
    if (transportFailureIsAmbiguous && (response.ok || [502, 503, 504].includes(response.status))) {
      throw new StudioDomainError(
        "infrastructure",
        response.status || 503,
        correlationId,
        "The mutation response was invalid. Its outcome is not yet confirmed.",
        true,
      );
    }
    throw error;
  }
  if (!response.ok) {
    const error = parseError(body, response, correlationId);
    if (transportFailureIsAmbiguous && [502, 503, 504].includes(response.status)) {
      throw new StudioDomainError(
        error.code,
        error.status,
        error.correlationId,
        "The mutation outcome is not yet confirmed.",
        true,
      );
    }
    throw error;
  }
  return body;
}

function parseAuthUserPage(value: unknown): StudioAuthUserPage {
  const record = readRecord(value);
  return Object.freeze({
    users: Object.freeze(readArray(record.users, 100).map(parseAuthUser)),
    totalCount: readNonNegativeInteger(record.totalCount),
    limit: boundedInteger(readNonNegativeInteger(record.limit), 50, 1, 100),
    offset: readNonNegativeInteger(record.offset),
  });
}

function parseAuthUser(value: unknown): StudioAuthUser {
  const record = readRecord(value);
  return Object.freeze({
    id: readResourceId(record.id),
    email: readEmail(record.email),
    name: readBoundedText(record.name, 256),
    emailVerified: readBoolean(record.emailVerified),
    createdAt: readIsoDate(record.createdAt),
    updatedAt: readIsoDate(record.updatedAt),
    sessionCount: readNonNegativeInteger(record.sessionCount),
  });
}

function parseAuthUserDetail(value: unknown): StudioAuthUserDetail {
  const record = readRecord(value);
  const user = readRecord(record.user);
  return Object.freeze({
    user: Object.freeze({
      id: readResourceId(user.id),
      email: readEmail(user.email),
      name: readBoundedText(user.name, 256),
      emailVerified: readBoolean(user.emailVerified),
      createdAt: readIsoDate(user.createdAt),
    }),
    sessions: Object.freeze(
      readArray(record.sessions, 100).map((session) => {
        const item = readRecord(session);
        return Object.freeze({
          id: readResourceId(item.id),
          createdAt: readIsoDate(item.createdAt),
          expiresAt: readIsoDate(item.expiresAt),
        });
      }),
    ),
  });
}

function parseAuthSettings(value: unknown): StudioAuthSettings {
  const record = readRecord(value);
  return Object.freeze({
    providers: Object.freeze(readArray(record.providers, 2).map(parseAuthProviderSetting)),
    redirectUrls: parseRedirectUrls(record.redirectUrls),
    templates: Object.freeze(readArray(record.templates, 2).map(parseAuthTemplateSetting)),
  });
}

function parseAuthProviderSetting(value: unknown): StudioAuthProviderSetting {
  const record = readRecord(value);
  return Object.freeze({
    provider: readOneOf(record.provider, ["google", "github"] as const),
    enabled: readBoolean(record.enabled),
    clientIdConfigured: readBoolean(record.clientIdConfigured),
    clientSecretConfigured: readBoolean(record.clientSecretConfigured),
  });
}

function parseAuthTemplateSetting(value: unknown): StudioAuthTemplateSetting {
  const record = readRecord(value);
  return Object.freeze({
    template: readOneOf(record.template, ["email-verification", "password-reset"] as const),
    subject: readBoundedText(record.subject, 160),
    text: readBoundedText(record.text, 16_384),
  });
}

function parseRedirectUrls(value: unknown): readonly string[] {
  return Object.freeze(
    readArray(value, 32).map((url) => {
      const text = readBoundedText(url, 2048);
      try {
        if (new URL(text).toString() !== text) throw malformedResponse();
      } catch {
        throw malformedResponse();
      }
      return text;
    }),
  );
}

function readResourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) throw malformedResponse();
  return value;
}

function assertResourceId(value: string): void {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(value))
    throw new StudioDomainError("validation", 400, createCorrelationId());
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value))
    throw new StudioDomainError("validation", 400, createCorrelationId());
}

function readEmail(value: unknown): string {
  const email = readBoundedText(value, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw malformedResponse();
  return email;
}

function readBoundedText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw malformedResponse();
  return value;
}

function readIsoDate(value: unknown): string {
  const text = readBoundedText(value, 64);
  if (new Date(text).toISOString() !== text) throw malformedResponse();
  return text;
}

async function onboardingRequest(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  getCredential:
    | (() =>
        | Promise<Extract<StudioCredential, { kind: "session" }> | undefined>
        | Extract<StudioCredential, { kind: "session" }>
        | undefined)
    | undefined,
  path: string,
  method: "POST",
  payload: StudioOnboardingRequest | undefined,
  idempotencyKey: string,
): Promise<StudioOnboarding> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  const correlationId = createCorrelationId();
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    [tenantHeaders.correlationId]: correlationId,
  });
  const credential = await getCredential?.();
  if (credential !== undefined) headers.set("authorization", readCredential(credential));
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/${path}`, {
      method,
      credentials: "include",
      headers,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new StudioDomainError("infrastructure", 503, correlationId);
  }
  const body = await readJson(response, correlationId);
  if (!response.ok) throw parseError(body, response, correlationId);
  return parseOnboarding(body);
}

function parseTables(value: unknown): readonly StudioTable[] {
  return Object.freeze(readArray(value, 10_000).map(parseTable));
}

function parseTable(value: unknown): StudioTable {
  const record = readRecord(value);
  const name = readString(record.name);
  const columns = readArray(record.columns, 1_024);
  for (const column of columns) readString(readRecord(column).name);
  readArray(record.indexes, 1_024);
  const primaryKey = Object.freeze(readArray(record.primaryKey, 64).map(readString));
  return Object.freeze({
    id: name,
    name,
    namespace: "main",
    kind: "table",
    columnCount: columns.length,
    primaryKey,
  });
}

function parseTableDefinition(value: unknown): StudioTableDefinition {
  const record = readRecord(value);
  const columns = Object.freeze(readArray(record.columns, 1_024).map(parseTableColumn));
  const primaryKey = Object.freeze(readArray(record.primaryKey, 64).map(readString));
  return Object.freeze({ name: readIdentifier(record.name), columns, primaryKey });
}

function parseTableColumn(value: unknown): StudioTableColumn {
  const record = readRecord(value);
  return Object.freeze({
    name: readIdentifier(record.name),
    type: readColumnType(record.type),
    nullable: readBoolean(record.nullable),
    primaryKey: readNonNegativeInteger(record.primaryKeyPosition) > 0,
  });
}

function parseMutation(value: unknown): StudioSchemaMutation<StudioTableDefinition> {
  const record = readRecord(value);
  return Object.freeze({
    resource: parseTableDefinition(record.resource),
    migrationSql: readMigrationSql(record.migrationSql),
    checkpointId: record.checkpointId === null ? null : readBoundedIdentifier(record.checkpointId),
  });
}

function parseSchemaHealth(value: unknown): StudioSchemaHealth {
  const record = readRecord(value);
  if (record.status !== "ok") throw malformedResponse();
  return Object.freeze({
    status: "ok",
    formatVersion: readNonNegativeInteger(record.formatVersion),
    schemaVersion: readNonNegativeInteger(record.schemaVersion),
    schemaHash: readSchemaHash(record.schemaHash),
  });
}

function parseRowsPage(value: unknown): StudioRowsPage {
  const record = readRecord(value);
  return Object.freeze({
    rows: Object.freeze(readArray(record.rows, 200).map(parseRow)),
    totalCount: readNonNegativeInteger(record.totalCount),
    limit: boundedInteger(readNonNegativeInteger(record.limit), 50, 1, 200),
    offset: readNonNegativeInteger(record.offset),
  });
}

function parseSqlResult(value: unknown): StudioSqlResult {
  const record = readRecord(value);
  return Object.freeze({
    rows: Object.freeze(readArray(record.rows, 200).map(parseRow)),
    changes: readNonNegativeInteger(record.changes),
  });
}

function parseChanges(value: unknown): Readonly<{ changes: number }> {
  return Object.freeze({ changes: readNonNegativeInteger(readRecord(value).changes) });
}

function parseRow(value: unknown): StudioRow {
  const record = readRecord(value);
  const row: Record<string, StudioRowValue> = {};
  for (const [column, cell] of Object.entries(record)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(column)) throw malformedResponse();
    if (typeof cell !== "string" && typeof cell !== "number" && cell !== null)
      throw malformedResponse();
    if (typeof cell === "number" && !Number.isFinite(cell)) throw malformedResponse();
    row[column] = cell;
  }
  return Object.freeze(row);
}

function parseOnboarding(value: unknown): StudioOnboarding {
  const record = readRecord(value);
  const status = readOneOf(record.status, ["provisioning", "ready", "failed"] as const);
  const phase = readOneOf(record.phase, [
    "catalog",
    "database",
    "credentials",
    "health",
    "cleanup",
    "complete",
  ] as const);
  const errorCode = record.errorCode === null ? null : readErrorCode(record.errorCode);
  const connection = record.connection === null ? null : parseConnection(record.connection);
  if ((status === "ready") !== (connection !== null)) throw malformedResponse();
  return Object.freeze({
    id: readBoundedIdentifier(record.id),
    projectId: readBoundedIdentifier(record.projectId),
    status,
    phase,
    errorCode,
    connection,
  });
}

function parseConnection(value: unknown): Readonly<{ apiUrl: string; publishableKey: string }> {
  const record = readRecord(value);
  const apiUrl = readString(record.apiUrl);
  const publishableKey = readString(record.publishableKey);
  if (!/^https:\/\//.test(apiUrl) || !/^pk_/.test(publishableKey)) throw malformedResponse();
  return Object.freeze({ apiUrl, publishableKey });
}

function parseError(
  value: unknown,
  response: Response,
  fallback: CorrelationId,
): StudioDomainError {
  try {
    const error = readRecord(readRecord(value).error);
    const code = readErrorCode(error.code);
    const correlationId = parseCorrelationId(
      error.correlationId ?? response.headers.get(tenantHeaders.correlationId),
    );
    return new StudioDomainError(code, response.status, correlationId);
  } catch {
    return new StudioDomainError("infrastructure", response.status, fallback);
  }
}

async function readJson(response: Response, correlationId: CorrelationId): Promise<unknown> {
  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes)
      throw malformedResponse();
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > maxResponseBytes) throw malformedResponse();
    return JSON.parse(body) as unknown;
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new StudioDomainError("infrastructure", response.status || 503, correlationId);
  }
}

function readCredential(credential: StudioCredential): string {
  const value = credential.kind === "session" ? credential.token : credential.key;
  if (value.trim().length < 8 || value.length > 8192)
    throw new StudioDomainError("validation", 400, createCorrelationId());
  return credential.kind === "session" ? `Bearer ${value}` : value;
}

function normalizeBaseUrl(value: string): string {
  if (value.length === 0) throw new Error("Studio Domain SDK baseUrl is required.");
  return value.replace(/\/$/, "");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  return resolved;
}

function readMutationTimeout(value: number | undefined): number {
  const timeout = value ?? defaultMutationTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new Error("Studio Domain SDK mutationTimeoutMs must be between 1 and 120000.");
  }
  return timeout;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw malformedResponse();
  return value as Record<string, unknown>;
}

function readArray(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) throw malformedResponse();
  return value;
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128)
    throw malformedResponse();
  return value;
}

function readIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw malformedResponse();
  }
  return value;
}

function readColumnType(value: unknown): StudioColumnType {
  return readOneOf(value, ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"] as const);
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw malformedResponse();
  return value;
}

function readMigrationSql(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16_384) {
    throw malformedResponse();
  }
  return value;
}

function readBoundedIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) throw malformedResponse();
  return value;
}

function readOneOf<const Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) throw malformedResponse();
  return value as Value;
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw malformedResponse();
  return value;
}

function readSchemaHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw malformedResponse();
  return value;
}

function assertIdentifier(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function assertCreatableIdentifier(value: string): void {
  assertIdentifier(value);
  const normalized = value.toLowerCase();
  if (normalized.startsWith("sqlite_") || normalized.startsWith("_mekka_")) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function assertSchemaHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function validateCreateTable(value: {
  name: string;
  columns: readonly StudioTableColumn[];
  expectedSchemaHash: string;
}): void {
  assertCreatableIdentifier(value.name);
  assertSchemaHash(value.expectedSchemaHash);
  if (!Array.isArray(value.columns) || value.columns.length === 0 || value.columns.length > 64) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  for (const column of value.columns) validateColumn(column, true, true);
  if (new Set(value.columns.map((column) => column.name)).size !== value.columns.length) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function validateColumn(
  value: Omit<StudioTableColumn, "primaryKey"> | StudioTableColumn,
  allowPrimaryKey: boolean,
  creatable = true,
): void {
  if (creatable) assertCreatableIdentifier(value.name);
  else assertIdentifier(value.name);
  readColumnType(value.type);
  if (typeof value.nullable !== "boolean") {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  if ("primaryKey" in value && value.primaryKey === true && !allowPrimaryKey) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function validateRow(value: StudioRow, allowEmpty: boolean): void {
  const entries = Object.entries(value);
  if ((entries.length === 0 && !allowEmpty) || entries.length > 64) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  for (const [column, cell] of entries) {
    assertIdentifier(column);
    validateRowValue(cell);
  }
}

function validateRowValue(value: unknown): asserts value is StudioRowValue {
  if (typeof value !== "string" && typeof value !== "number" && value !== null) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  if (typeof value === "string" && value.length > 16_384) {
    throw new StudioDomainError("quota", 429, createCorrelationId());
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
}

function validateSql(sql: string): void {
  if (typeof sql !== "string" || sql.trim().length === 0 || sql.length > 8_192) {
    throw new StudioDomainError("validation", 400, createCorrelationId());
  }
  if (
    /\b(?:attach|detach|pragma|vacuum|begin|commit|rollback|savepoint|release|alter|create|drop|replace|reindex|analyze|trigger|virtual|load_extension)\b/i.test(
      sql,
    ) ||
    /;\s*\S/.test(sql)
  ) {
    throw new StudioDomainError("unsupported", 501, createCorrelationId());
  }
  if (!/^(?:\s*(?:select|insert|update|delete)\b)/i.test(sql)) {
    throw new StudioDomainError("unsupported", 501, createCorrelationId());
  }
}

function readErrorCode(value: unknown): ErrorCode {
  if (
    value === "validation" ||
    value === "auth" ||
    value === "forbidden" ||
    value === "conflict" ||
    value === "quota" ||
    value === "unsupported" ||
    value === "infrastructure"
  )
    return value;
  throw malformedResponse();
}

function malformedResponse(): StudioDomainError {
  return new StudioDomainError("infrastructure", 503, createCorrelationId());
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(code: ErrorCode): string {
  switch (code) {
    case "auth":
      return "Your Studio session has expired. Sign in again.";
    case "forbidden":
      return "You do not have permission to perform this project operation.";
    case "conflict":
      return "The project resource changed while this request was running. Reload and try again.";
    case "validation":
      return "The Studio request is invalid.";
    case "quota":
      return "The project quota was exceeded.";
    case "unsupported":
      return "This project operation is not supported.";
    case "infrastructure":
      return "The project service is temporarily unavailable.";
  }
}
