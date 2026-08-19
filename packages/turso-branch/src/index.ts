import { createHash, randomUUID } from "node:crypto";
import {
  EngineError,
  type EngineErrorCode,
  type EngineOutcome,
  readServerToken,
} from "@mekka/engine-core";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";

/**
 * Thin adapter for the official Turso Platform API branch lifecycle. Pinned to the
 * documented REST contract:
 *
 * - Create database (fork): `POST /v1/organizations/{org}/databases` with
 *   `{ name, group, seed: { type: "database", name: "<source>" } }`.
 * - Retrieve database: `GET /v1/organizations/{org}/databases/{name}`.
 * - Delete database: `DELETE /v1/organizations/{org}/databases/{name}`.
 * - Database auth token: `POST /v1/organizations/{org}/databases/{name}/auth/tokens`.
 *
 * The official `@tursodatabase/api` client is deliberately not used: it performs an
 * unbounded global `fetch` with no injectable transport, so it cannot satisfy the
 * product requirement that every provider operation supports timeout/abort, and it
 * cannot be driven deterministically in tests. The adapter implements the pinned
 * contract with a bounded transport instead and reuses the provider's idempotency
 * primitive: database names are unique per organization, so a `409 Conflict` on
 * create is resolved by retrieving the database and verifying its parent before
 * replaying success.
 *
 * The adapter never exposes the API token in errors, events or results.
 */

export type TursoBranchOperation = "probe" | "create" | "token" | "status" | "delete";

/**
 * One observable provider operation. The event is intentionally minimal: operation
 * id, latency, typed error code and route. It never contains the API token, database
 * names, URLs or response payloads.
 */
export type TursoBranchOperationEvent = Readonly<{
  operationId: string;
  operation: TursoBranchOperation;
  outcome: EngineOutcome;
  errorCode: EngineErrorCode | null;
  latencyMs: number;
  attempts: number;
}>;

export type TursoBranchOperationObserver = (event: TursoBranchOperationEvent) => void;

export type TursoBranchConfig = Readonly<{
  /** Platform API base URL. Defaults to `https://api.turso.tech`. */
  baseUrl?: string;
  /** Organization (or account) slug. */
  organization: string;
  /** Existing group the forked databases are created in. */
  group: string;
  /** Existing database the preview databases fork from. */
  sourceDatabase: string;
  /** Name of an environment variable holding the platform API token. */
  apiTokenReference: string;
  /** Upper bound for every provider request, in milliseconds. Defaults to `defaultTursoBranchRequestTimeoutMs`. */
  requestTimeoutMs?: number;
  /** Allows `http://` for loopback hosts (explicit local development mode). Defaults to `false`. */
  allowLocalhost?: boolean;
  /** Custom transport. Defaults to the global `fetch`. Tests inject a deterministic transport stub. */
  fetch?: TursoBranchTransport;
  /** Generates an operation id per operation. Defaults to a random UUID. */
  operationIdProvider?: () => string;
  /** Minimal observability sink; events never contain secrets or payloads. */
  onOperation?: TursoBranchOperationObserver;
}>;

export type TursoBranchCapability = Readonly<{
  provider: "turso";
  supported: boolean;
  reason: string | null;
}>;

export type TursoBranchDatabase = Readonly<{
  resourceId: string;
  name: string;
  hostname: string;
  group: string;
  parentName: string | null;
}>;

export type TursoBranchCreateInput = Readonly<{
  /** Turso database name; lowercase letters, numbers and dashes, at most 64 characters. */
  name: string;
  /** Auth token lifetime in seconds; bounded to [1h, 30d]. This is the provider TTL. */
  tokenExpirationSeconds: number;
}>;

export type TursoBranchCreated = Readonly<{
  database: TursoBranchDatabase;
  /** Server-side database auth token. Must never be returned to the browser. */
  token: string;
  tokenExpiresAt: number;
}>;

export type TursoBranchStatus = Readonly<{
  exists: boolean;
  database: TursoBranchDatabase | null;
}>;

export type TursoBranchProbeResult = Readonly<{
  ok: boolean;
  error: EngineError | null;
}>;

export type TursoBranchDeleteResult = Readonly<{
  deleted: boolean;
}>;

export type TursoBranchAdapter = Readonly<{
  /**
   * Static capability derived from configuration. A configured adapter is
   * `supported`; an unconfigured one is honestly `unsupported` so the caller keeps
   * the main libSQL path working.
   */
  capabilities(): TursoBranchCapability;
  /** One authenticated round trip; verifies the platform token and organization. */
  probe(
    options?: Readonly<{ operationId?: string; signal?: AbortSignal }>,
  ): Promise<TursoBranchProbeResult>;
  /**
   * Forks a database and mints a bounded auth token. Retrying the same `name` is
   * safe: a provider `409 Conflict` is resolved by retrieving the database and
   * verifying its parent before replaying success.
   */
  createBranch(
    input: TursoBranchCreateInput,
    options?: Readonly<{ operationId?: string; signal?: AbortSignal }>,
  ): Promise<TursoBranchCreated>;
  getBranchStatus(
    name: string,
    options?: Readonly<{ operationId?: string; signal?: AbortSignal }>,
  ): Promise<TursoBranchStatus>;
  /**
   * Deletes the database. Deleting a database that no longer exists at the provider
   * reports success, so the caller can retry deletes idempotently.
   */
  deleteBranch(
    name: string,
    options?: Readonly<{ operationId?: string; signal?: AbortSignal }>,
  ): Promise<TursoBranchDeleteResult>;
  /** Public provider identity; never contains the API token. */
  publicInfo(): TursoBranchPublicInfo;
}>;

export type TursoBranchPublicInfo = Readonly<{
  provider: "turso";
  organization: string;
  group: string;
  sourceDatabase: string;
  baseUrl: string;
}>;

export type TursoBranchTransport = (
  input: Request | URL | string,
  init?: RequestInit,
) => Promise<Response>;

export const defaultTursoBranchRequestTimeoutMs = 10_000;
export const defaultTursoBranchBaseUrl = "https://api.turso.tech";

export const minimumTokenExpirationSeconds = 60 * 60;
export const maximumTokenExpirationSeconds = 60 * 60 * 24 * 30;

const organizationPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const databaseNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createTursoBranchAdapter(config: TursoBranchConfig): TursoBranchAdapter {
  const validated = validateConfig(config);
  const token = readServerToken(config.apiTokenReference);
  const operationIdProvider = config.operationIdProvider ?? (() => randomUUID());
  const transport = config.fetch ?? globalThis.fetch;

  const adapter: TursoBranchAdapter = Object.freeze({
    capabilities,
    probe,
    createBranch,
    getBranchStatus,
    deleteBranch,
    publicInfo,
  });

  const emitOperation = (
    operationId: string,
    operation: TursoBranchOperation,
    outcome: EngineOutcome,
    errorCode: EngineErrorCode | null,
    latencyMs: number,
    attempts: number,
  ): void => {
    if (config.onOperation === undefined) return;
    try {
      config.onOperation(
        Object.freeze({
          operationId,
          operation,
          outcome,
          errorCode,
          latencyMs,
          attempts,
        }),
      );
    } catch {
      // Observability must never break the provider path.
    }
  };

  const request = async (
    method: "GET" | "POST" | "DELETE",
    path: string,
    operation: TursoBranchOperation,
    operationId: string,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    const startedAt = performance.now();
    const url = new URL(path, validated.baseUrl).href;
    try {
      const headers = new Headers({ accept: "application/json" });
      headers.set("authorization", `Bearer ${token}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      const response = await boundedFetch(
        transport,
        url,
        method,
        headers,
        body,
        signal,
        validated.requestTimeoutMs,
      );
      emitOperation(operationId, operation, "ok", null, measureLatency(startedAt), 1);
      return response;
    } catch (error) {
      const mapped = mapTursoBranchError(error);
      const classified = associateOperationId(mapped, operationId);
      emitOperation(
        operationId,
        operation,
        classified.outcome,
        classified.code,
        measureLatency(startedAt),
        1,
      );
      throw classified;
    }
  };

  return adapter;

  function capabilities(): TursoBranchCapability {
    return Object.freeze({
      provider: "turso",
      supported: true,
      reason: null,
    });
  }

  async function probe(
    options: Readonly<{ operationId?: string; signal?: AbortSignal }> | undefined,
  ): Promise<TursoBranchProbeResult> {
    const operationId = resolveOperationId(options, operationIdProvider);
    try {
      await request(
        "GET",
        `/v1/organizations/${validated.organization}`,
        "probe",
        operationId,
        undefined,
        options?.signal,
      );
      return Object.freeze({ ok: true, error: null });
    } catch (error) {
      const mapped = error instanceof EngineError ? error : mapTursoBranchError(error);
      return Object.freeze({ ok: false, error: associateOperationId(mapped, operationId) });
    }
  }

  async function createBranch(
    input: TursoBranchCreateInput,
    options: Readonly<{ operationId?: string; signal?: AbortSignal }> | undefined,
  ): Promise<TursoBranchCreated> {
    const operationId = resolveOperationId(options, operationIdProvider);
    validateCreateInput(input);
    const expiration = expirationQuery(input.tokenExpirationSeconds);
    const createBody = {
      name: input.name,
      group: validated.group,
      seed: { type: "database", name: validated.sourceDatabase },
    };
    let response: Response;
    try {
      response = await request(
        "POST",
        `/v1/organizations/${validated.organization}/databases`,
        "create",
        operationId,
        createBody,
        options?.signal,
      );
    } catch (error) {
      if (!(error instanceof EngineError) || error.code !== "ENGINE_CONFLICT") {
        throw error;
      }
      // Provider idempotency primitive: the database name is unique per
      // organization. A conflict means a previous create attempt succeeded (or a
      // foreign database collides). Verify the parent before replaying success.
      const status = await adapter.getBranchStatus(input.name, {
        operationId,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!status.exists) {
        throw associateOperationId(
          new EngineError(
            "ENGINE_CONFLICT",
            "The provider rejected the branch creation because of a conflicting state.",
          ),
          operationId,
        );
      }
      if (status.database?.parentName !== validated.sourceDatabase) {
        throw associateOperationId(
          new EngineError(
            "ENGINE_CONFLICT",
            "The provider database name collides with a database that is not this branch.",
          ),
          operationId,
        );
      }
      const created = await mintDatabaseToken(
        input.name,
        expiration,
        input.tokenExpirationSeconds,
        operationId,
        options?.signal,
      );
      return Object.freeze({ database: status.database, ...created });
    }
    const database = await parseDatabase(response);
    const created = await mintDatabaseToken(
      database.name,
      expiration,
      input.tokenExpirationSeconds,
      operationId,
      options?.signal,
    );
    return Object.freeze({ database, ...created });
  }

  async function getBranchStatus(
    name: string,
    options: Readonly<{ operationId?: string; signal?: AbortSignal }> | undefined,
  ): Promise<TursoBranchStatus> {
    const operationId = resolveOperationId(options, operationIdProvider);
    validateDatabaseName(name);
    try {
      const response = await request(
        "GET",
        `/v1/organizations/${validated.organization}/databases/${encodeURIComponent(name)}`,
        "status",
        operationId,
        undefined,
        options?.signal,
      );
      return Object.freeze({
        exists: true,
        database: await parseDatabase(response),
      });
    } catch (error) {
      if (error instanceof EngineError && error.code === "ENGINE_NOT_FOUND") {
        return Object.freeze({ exists: false, database: null });
      }
      throw error;
    }
  }

  async function deleteBranch(
    name: string,
    options: Readonly<{ operationId?: string; signal?: AbortSignal }> | undefined,
  ): Promise<TursoBranchDeleteResult> {
    const operationId = resolveOperationId(options, operationIdProvider);
    validateDatabaseName(name);
    try {
      await request(
        "DELETE",
        `/v1/organizations/${validated.organization}/databases/${encodeURIComponent(name)}`,
        "delete",
        operationId,
        undefined,
        options?.signal,
      );
      return Object.freeze({ deleted: true });
    } catch (error) {
      if (error instanceof EngineError && error.code === "ENGINE_NOT_FOUND") {
        // Idempotent delete: the provider resource is already gone.
        return Object.freeze({ deleted: true });
      }
      throw error;
    }
  }

  function publicInfo(): TursoBranchPublicInfo {
    return Object.freeze({
      provider: "turso",
      organization: validated.organization,
      group: validated.group,
      sourceDatabase: validated.sourceDatabase,
      baseUrl: new URL(validated.baseUrl).origin,
    });
  }

  async function mintDatabaseToken(
    name: string,
    expiration: string,
    tokenExpirationSeconds: number,
    operationId: string,
    signal: AbortSignal | undefined,
  ): Promise<Readonly<{ token: string; tokenExpiresAt: number }>> {
    const response = await request(
      "POST",
      `/v1/organizations/${validated.organization}/databases/${encodeURIComponent(name)}/auth/tokens?expiration=${expiration}&authorization=full-access`,
      "token",
      operationId,
      undefined,
      signal,
    );
    const payload = await readBoundedJson(response);
    const record = readRecord(payload);
    const tokenValue = record.jwt;
    if (typeof tokenValue !== "string" || tokenValue.trim().length < 16) {
      throw associateOperationId(
        new EngineError("ENGINE_FAILED", "The provider issued an invalid database token."),
        operationId,
      );
    }
    return Object.freeze({
      token: tokenValue,
      tokenExpiresAt: Date.now() + tokenExpirationSeconds * 1000,
    });
  }
}

/**
 * Builds a Turso-compatible database name from the full tenant identity: lowercase
 * letters, numbers and dashes, at most 64 characters, with a short hash suffix so
 * retries of the same tenant always resolve to the same provider resource.
 */
export function buildBranchDatabaseName(tenant: TenantIdentity): string {
  const parsed = parseTenantIdentity(tenant);
  const core = `${parsed.organizationId}-${parsed.projectId}-${parsed.environmentId}-${parsed.branchId}-g${parsed.generation}`;
  const slug = core
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(core).digest("hex").slice(0, 12);
  return `mekka-${slug}-${hash}`;
}

function validateConfig(config: TursoBranchConfig): Readonly<{
  baseUrl: string;
  organization: string;
  group: string;
  sourceDatabase: string;
  requestTimeoutMs: number;
}> {
  const organization = validateIdentifier(config.organization, "organization");
  const group = validateIdentifier(config.group, "group");
  const sourceDatabase = validateDatabaseName(config.sourceDatabase);
  if (
    typeof config.apiTokenReference !== "string" ||
    config.apiTokenReference.trim().length === 0
  ) {
    throw new EngineError("ENGINE_FAILED", "The Turso platform token reference must not be empty.");
  }
  const baseUrl = validateBaseUrl(
    config.baseUrl ?? defaultTursoBranchBaseUrl,
    config.allowLocalhost === true,
  );
  const requestTimeoutMs = validateRequestTimeout(config.requestTimeoutMs);
  return Object.freeze({ baseUrl, organization, group, sourceDatabase, requestTimeoutMs });
}

function validateIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || !organizationPattern.test(value)) {
    throw new EngineError(
      "ENGINE_FAILED",
      `The Turso ${name} slug must be lowercase alphanumeric with dashes (2-64 characters).`,
    );
  }
  return value;
}

function validateDatabaseName(value: string): string {
  if (typeof value !== "string" || !databaseNamePattern.test(value)) {
    throw new EngineError(
      "ENGINE_FAILED",
      "The Turso database name must be lowercase alphanumeric with dashes (max 64 characters).",
    );
  }
  return value;
}

function validateCreateInput(input: TursoBranchCreateInput): void {
  validateDatabaseName(input.name);
  if (
    !Number.isSafeInteger(input.tokenExpirationSeconds) ||
    input.tokenExpirationSeconds < minimumTokenExpirationSeconds ||
    input.tokenExpirationSeconds > maximumTokenExpirationSeconds
  ) {
    throw new EngineError(
      "ENGINE_FAILED",
      `Token expiration must be an integer between ${minimumTokenExpirationSeconds} and ${maximumTokenExpirationSeconds} seconds.`,
    );
  }
}

function validateBaseUrl(value: string, allowLocalhost: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EngineError("ENGINE_FAILED", "The Turso API base URL must not be empty.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EngineError("ENGINE_FAILED", "The Turso API base URL is not a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EngineError(
      "ENGINE_FAILED",
      'The Turso API base URL scheme must be "https:" (or "http:" for loopback local development).',
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new EngineError(
      "ENGINE_FAILED",
      "The Turso API base URL must not contain credentials; use the token reference instead.",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new EngineError(
      "ENGINE_FAILED",
      "The Turso API base URL must not contain a query string or fragment.",
    );
  }
  if (url.protocol === "http:") {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0:0:0:0:0:0:0:1";
    if (!allowLocalhost || !isLoopback) {
      throw new EngineError(
        "ENGINE_FAILED",
        '"http://" is allowed only for loopback hosts in explicit local development mode.',
      );
    }
  }
  return url.href.replace(/\/$/, "");
}

function validateRequestTimeout(value: number | undefined): number {
  const timeout = value ?? defaultTursoBranchRequestTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
    throw new EngineError(
      "ENGINE_FAILED",
      "requestTimeoutMs must be an integer between 1 and 60_000.",
    );
  }
  return timeout;
}

function expirationQuery(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return (
    `${days > 0 ? `${days}d` : ""}${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}` ||
    "1h"
  );
}

async function parseDatabase(response: Response): Promise<TursoBranchDatabase> {
  const payload = await readBoundedJson(response);
  const record = readRecord(payload);
  const database = readRecord(record.database);
  const resourceId = database.DbId;
  const name = database.Name;
  const hostname = database.Hostname;
  if (
    typeof resourceId !== "string" ||
    resourceId.length < 1 ||
    resourceId.length > 128 ||
    typeof name !== "string" ||
    !databaseNamePattern.test(name) ||
    typeof hostname !== "string" ||
    hostname.length < 1 ||
    hostname.length > 253
  ) {
    throw new EngineError("ENGINE_FAILED", "The provider returned an invalid database record.");
  }
  const parent =
    database.parent !== null && typeof database.parent === "object"
      ? readRecord(database.parent)
      : null;
  const parentName = parent?.name;
  return Object.freeze({
    resourceId,
    name,
    hostname,
    group: typeof database.group === "string" ? database.group : "",
    parentName: typeof parentName === "string" && parentName.length > 0 ? parentName : null,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = await readBoundedText(response);
  if (!contentType.includes("application/json") || body.trim().length === 0) {
    throw new EngineError("ENGINE_FAILED", "The provider returned an unreadable response.");
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new EngineError("ENGINE_FAILED", "The provider returned an invalid response.");
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    await response.body?.cancel();
    throw new EngineError("ENGINE_FAILED", "The provider response is too large.");
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > 16_384) {
    throw new EngineError("ENGINE_FAILED", "The provider response is too large.");
  }
  return body;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EngineError("ENGINE_FAILED", "The provider returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

async function boundedFetch(
  transport: TursoBranchTransport,
  url: string,
  method: string,
  headers: Headers,
  body: unknown,
  signal: AbortSignal | undefined,
  requestTimeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const onParentAbort = (): void => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }
  try {
    const response = await transport(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new TransportTimeoutError("The provider request exceeded the configured timeout.");
    }
    if (!response.ok) {
      throw new ProviderHttpError(response.status, await readBoundedText(response).catch(() => ""));
    }
    return response;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TransportTimeoutError(
        "The provider request exceeded the configured timeout.",
        error,
      );
    }
    if (error instanceof ProviderHttpError) throw error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

class TransportTimeoutError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "TransportTimeoutError";
    this.cause = cause;
  }
}

class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

export function mapTursoBranchError(error: unknown): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  if (error instanceof TransportTimeoutError) {
    // The request may have reached the provider before the timeout fired; the outcome is unknown.
    return new EngineError("ENGINE_TIMEOUT", "The provider request timed out.", error, "unknown");
  }
  if (error instanceof ProviderHttpError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new EngineError(
        "ENGINE_AUTH",
        "The provider rejected the server-side platform credentials.",
        error,
      );
    }
    if (status === 404) {
      return new EngineError("ENGINE_NOT_FOUND", "The provider resource does not exist.", error);
    }
    if (status === 409) {
      return new EngineError(
        "ENGINE_CONFLICT",
        "The provider rejected the operation because of a conflicting state.",
        error,
      );
    }
    if (status === 429) {
      return new EngineError(
        "ENGINE_RATE_LIMITED",
        "The provider is rate limiting requests; retry later.",
        error,
      );
    }
    if (status === 408 || status === 504) {
      return new EngineError("ENGINE_TIMEOUT", "The provider request timed out.", error, "unknown");
    }
    if (status >= 500) {
      return new EngineError(
        "ENGINE_UNAVAILABLE",
        "The provider is temporarily unavailable.",
        error,
        "unknown",
      );
    }
    return new EngineError(
      "ENGINE_FAILED",
      "The provider rejected the operation; the request was not applied.",
      error,
    );
  }
  if (error instanceof TypeError) {
    // DNS/request-level failures cannot prove whether the request was sent; conservative unknown.
    return new EngineError(
      "ENGINE_UNAVAILABLE",
      "The provider could not be reached.",
      error,
      "unknown",
    );
  }
  return new EngineError(
    "ENGINE_FAILED",
    "The provider operation failed unexpectedly.",
    error,
    "unknown",
  );
}

export function associateOperationId(error: EngineError, operationId: string): EngineError {
  if (error.operationId !== null) return error;
  return new EngineError(error.code, error.message, error.cause, error.outcome, operationId);
}

function resolveOperationId(
  options: Readonly<{ operationId?: string; signal?: AbortSignal }> | undefined,
  fallbackProvider: () => string,
): string {
  const provided = options?.operationId?.trim();
  return provided === undefined || provided.length === 0 ? fallbackProvider() : provided;
}

function measureLatency(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
