import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";

export type AuthAdminAction = "auth:admin";

export type AuthAdminCapability = Readonly<{
  tenant: TenantIdentity;
  actorId: string;
  actions: readonly AuthAdminAction[];
  expiresAt: number;
}>;

export type AuthAdminContext = Readonly<{
  capability: AuthAdminCapability;
  csrfToken: string;
}>;

export type AuthAdminSecretName =
  | "auth/oauth/google-client-id"
  | "auth/oauth/google-client-secret"
  | "auth/oauth/github-client-id"
  | "auth/oauth/github-client-secret";

export type AuthAdminSecretStore = Readonly<{
  readSecret(
    input: Readonly<{ tenant: TenantIdentity; name: AuthAdminSecretName }>,
  ): Promise<string>;
  writeSecrets(
    inputs: readonly Readonly<{
      tenant: TenantIdentity;
      name: AuthAdminSecretName;
      value: string;
    }>[],
  ): Promise<void>;
}>;

export type AuthAdminAuditEvent = Readonly<{
  action:
    | "auth.user.sessions.revoke.requested"
    | "auth.user.delete.requested"
    | "auth.provider.update.requested"
    | "auth.redirects.update.requested"
    | "auth.template.update.requested";
  actorId: string;
  tenant: TenantIdentity;
  targetId: string;
  occurredAt: number;
  correlationId: string;
  details: Readonly<Record<string, string | number | boolean>>;
}>;

export type AuthAdminAuditSink = Readonly<{
  append(event: AuthAdminAuditEvent): Promise<void>;
}>;

export type AuthAdminOptions = Readonly<{
  studioOrigin: string;
  secretStore: AuthAdminSecretStore;
  auditSink: AuthAdminAuditSink;
}>;

export type AuthAdminOAuthConfiguration = Readonly<{
  providers: readonly AuthProvider[];
  redirectAllowlist: readonly string[];
}>;

export type AuthAdminHandler = (request: Request, context: AuthAdminContext) => Promise<Response>;

type AdminDependencies = Readonly<{
  database: Database;
  tenant: TenantIdentity;
  enabledProviders: readonly AuthProvider[];
  redirectAllowlist: readonly string[];
  options: AuthAdminOptions;
  verifyRedirectOrigins(urls: readonly string[]): Promise<boolean>;
  applyOAuthConfiguration(configuration: AuthAdminOAuthConfiguration): Promise<void>;
  now: () => number;
}>;

export type AuthProvider = "google" | "github";
type AuthTemplate = "email-verification" | "password-reset";

const providers = ["google", "github"] as const;
const templates = ["email-verification", "password-reset"] as const;
const maxBodyBytes = 64 * 1024;
const idPattern = /^[A-Za-z0-9_-]{3,128}$/;
const idempotencyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const csrfPattern = /^[A-Za-z0-9_-]{24,256}$/;
const correlationPattern = /^[A-Za-z0-9_-]{8,128}$/;

export function createAuthAdminHandler(dependencies: AdminDependencies): AuthAdminHandler {
  const tenant = parseTenantIdentity(dependencies.tenant);
  initializeAdminTables(
    dependencies.database,
    dependencies.enabledProviders,
    dependencies.redirectAllowlist,
  );

  return async (request, context) => {
    try {
      authorize(
        request,
        context,
        tenant,
        parseOrigin(dependencies.options.studioOrigin),
        dependencies.now(),
      );
      const url = new URL(request.url);
      const path = normalizedAdminPath(url.pathname);

      if (request.method === "GET" && path === "/users") {
        return jsonResponse(listUsers(dependencies.database, url.searchParams));
      }
      if (request.method === "GET" && /^\/users\/[A-Za-z0-9_-]{3,128}$/.test(path)) {
        return userResponse(dependencies.database, path.slice("/users/".length));
      }
      if (request.method === "POST" && /^\/users\/[A-Za-z0-9_-]{3,128}\/revoke$/.test(path)) {
        const userId = path.slice("/users/".length, -"/revoke".length);
        return await idempotentMutation(
          request,
          dependencies.database,
          path,
          async (correlationId) => {
            const body = await readObject(request);
            if (body.confirmation !== userId) throw new AdminError("validation", 400);
            if (!userExists(dependencies.database, userId)) throw new AdminError("validation", 404);
            await audit(dependencies, context, correlationId, {
              action: "auth.user.sessions.revoke.requested",
              targetId: userId,
              details: {},
            });
            revokeUserCredentials(dependencies.database, userId);
            return { revoked: true };
          },
        );
      }
      if (request.method === "DELETE" && /^\/users\/[A-Za-z0-9_-]{3,128}$/.test(path)) {
        const userId = path.slice("/users/".length);
        return await idempotentMutation(
          request,
          dependencies.database,
          path,
          async (correlationId) => {
            const body = await readObject(request);
            if (body.confirmation !== userId) throw new AdminError("validation", 400);
            if (!userExists(dependencies.database, userId)) throw new AdminError("validation", 404);
            await audit(dependencies, context, correlationId, {
              action: "auth.user.delete.requested",
              targetId: userId,
              details: {},
            });
            deleteUser(dependencies.database, userId);
            return { deleted: true, userId };
          },
        );
      }
      if (request.method === "GET" && path === "/settings") {
        return jsonResponse(readSettings(dependencies.database));
      }
      if (request.method === "PUT" && /^\/providers\/(?:google|github)$/.test(path)) {
        const provider = path.slice("/providers/".length) as AuthProvider;
        return await idempotentMutation(
          request,
          dependencies.database,
          path,
          async (correlationId) => {
            const update = parseProviderUpdate(await readObject(request));
            const current = readProviderSetting(dependencies.database, provider);
            if (
              (update.enabled && !(update.clientId !== undefined || current.clientIdConfigured)) ||
              (update.enabled &&
                !(update.clientSecret !== undefined || current.clientSecretConfigured))
            ) {
              throw new AdminError("validation", 400);
            }
            await audit(dependencies, context, correlationId, {
              action: "auth.provider.update.requested",
              targetId: provider,
              details: {
                enabled: update.enabled,
                clientIdUpdated: update.clientId !== undefined,
                clientSecretUpdated: update.clientSecret !== undefined,
              },
            });
            const secretUpdates = [
              ...(update.clientId === undefined
                ? []
                : [
                    {
                      tenant,
                      name: `auth/oauth/${provider}-client-id` as const,
                      value: update.clientId,
                    },
                  ]),
              ...(update.clientSecret === undefined
                ? []
                : [
                    {
                      tenant,
                      name: `auth/oauth/${provider}-client-secret` as const,
                      value: update.clientSecret,
                    },
                  ]),
            ];
            if (secretUpdates.length > 0) {
              await dependencies.options.secretStore.writeSecrets(secretUpdates);
            }
            const nextSetting = {
              enabled: update.enabled,
              clientIdConfigured: current.clientIdConfigured || update.clientId !== undefined,
              clientSecretConfigured:
                current.clientSecretConfigured || update.clientSecret !== undefined,
            };
            const configuration = readOAuthConfiguration(dependencies.database, {
              provider,
              enabled: nextSetting.enabled,
            });
            await dependencies.applyOAuthConfiguration(configuration);
            writeProviderSetting(dependencies.database, provider, nextSetting);
            return readProviderSetting(dependencies.database, provider);
          },
        );
      }
      if (request.method === "PUT" && path === "/redirects") {
        return await idempotentMutation(
          request,
          dependencies.database,
          path,
          async (correlationId) => {
            const urls = parseRedirectUpdate(await readObject(request));
            if (!(await dependencies.verifyRedirectOrigins(urls))) {
              throw new AdminError("validation", 400);
            }
            await audit(dependencies, context, correlationId, {
              action: "auth.redirects.update.requested",
              targetId: "redirect-allowlist",
              details: { count: urls.length },
            });
            await dependencies.applyOAuthConfiguration({
              providers: readEnabledProviders(dependencies.database),
              redirectAllowlist: urls,
            });
            writeSetting(dependencies.database, "redirects", JSON.stringify(urls));
            return { urls };
          },
        );
      }
      if (
        request.method === "PUT" &&
        /^\/templates\/(?:email-verification|password-reset)$/.test(path)
      ) {
        const template = path.slice("/templates/".length) as AuthTemplate;
        return await idempotentMutation(
          request,
          dependencies.database,
          path,
          async (correlationId) => {
            const update = parseTemplateUpdate(await readObject(request));
            await audit(dependencies, context, correlationId, {
              action: "auth.template.update.requested",
              targetId: template,
              details: { subjectLength: update.subject.length, textLength: update.text.length },
            });
            writeSetting(dependencies.database, `template:${template}`, JSON.stringify(update));
            return { template, ...update };
          },
        );
      }

      return jsonResponse({ error: { code: "unsupported" } }, 404);
    } catch (error) {
      if (error instanceof AdminError) {
        return jsonResponse({ error: { code: error.code } }, error.status);
      }
      return jsonResponse({ error: { code: "infrastructure" } }, 503);
    }
  };
}

class AdminError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

function authorize(
  request: Request,
  context: AuthAdminContext,
  tenant: TenantIdentity,
  publicOrigin: string,
  now: number,
): void {
  const capability = context.capability;
  if (
    !sameTenant(parseTenantIdentity(capability.tenant), tenant) ||
    !capability.actions.includes("auth:admin") ||
    capability.expiresAt <= now ||
    !idPattern.test(capability.actorId)
  ) {
    throw new AdminError("forbidden", 403);
  }
  if (request.method === "GET") return;
  const origin = request.headers.get("origin");
  const csrf = request.headers.get("x-mekka-csrf-token");
  if (
    origin !== publicOrigin ||
    !csrfPattern.test(context.csrfToken) ||
    csrf !== context.csrfToken
  ) {
    throw new AdminError("forbidden", 403);
  }
}

function normalizedAdminPath(pathname: string): string {
  const marker = "/admin";
  const index = pathname.lastIndexOf(marker);
  return index === -1 ? pathname : pathname.slice(index + marker.length) || "/";
}

function listUsers(database: Database, search: URLSearchParams) {
  const limit = parseBoundedInteger(search.get("limit"), 50, 1, 100);
  const offset = parseBoundedInteger(search.get("offset"), 0, 0, 10_000);
  const query = search.get("query")?.trim().toLowerCase() ?? "";
  if (query.length > 128) throw new AdminError("validation", 400);
  const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = database
    .query<
      {
        id: string;
        email: string;
        name: string;
        emailVerified: number | boolean;
        createdAt: Date | number | string;
        updatedAt: Date | number | string;
        sessionCount: number;
      },
      [string, string, number, number]
    >(`
      SELECT user.id, user.email, user.name, user.emailVerified,
        user.createdAt, user.updatedAt, COUNT(session.id) AS sessionCount
      FROM user
      LEFT JOIN session ON session.userId = user.id
      WHERE (? = '' OR lower(user.email) LIKE ? ESCAPE '\\')
      GROUP BY user.id
      ORDER BY user.createdAt DESC, user.id ASC
      LIMIT ? OFFSET ?
    `)
    .all(query, pattern, limit, offset);
  const count =
    database
      .query<{ count: number }, [string, string]>(
        "SELECT COUNT(*) AS count FROM user WHERE (? = '' OR lower(email) LIKE ? ESCAPE '\\')",
      )
      .get(query, pattern)?.count ?? 0;
  return {
    users: rows.map((row) => ({
      ...row,
      emailVerified: Boolean(row.emailVerified),
      createdAt: toIsoString(row.createdAt),
      updatedAt: toIsoString(row.updatedAt),
    })),
    totalCount: count,
    limit,
    offset,
  };
}

function userResponse(database: Database, userId: string): Response {
  const user = database
    .query<
      {
        id: string;
        email: string;
        name: string;
        emailVerified: number | boolean;
        createdAt: Date | number | string;
      },
      [string]
    >("SELECT id, email, name, emailVerified, createdAt FROM user WHERE id = ?")
    .get(userId);
  if (!user) return jsonResponse({ error: { code: "validation" } }, 404);
  const sessions = database
    .query<
      { id: string; expiresAt: Date | number | string; createdAt: Date | number | string },
      [string]
    >(
      "SELECT id, expiresAt, createdAt FROM session WHERE userId = ? ORDER BY createdAt DESC LIMIT 100",
    )
    .all(userId)
    .map((session) => ({
      id: session.id,
      expiresAt: toIsoString(session.expiresAt),
      createdAt: toIsoString(session.createdAt),
    }));
  return jsonResponse({
    user: {
      ...user,
      emailVerified: Boolean(user.emailVerified),
      createdAt: toIsoString(user.createdAt),
    },
    sessions,
  });
}

async function idempotentMutation(
  request: Request,
  database: Database,
  action: string,
  mutate: (correlationId: string) => Promise<unknown>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key") ?? "";
  const correlationId = request.headers.get("x-correlation-id") ?? "";
  if (!idempotencyPattern.test(key) || !correlationPattern.test(correlationId)) {
    throw new AdminError("validation", 400);
  }
  const body = await request.clone().text();
  if (body.length > maxBodyBytes) throw new AdminError("quota", 429);
  const requestHash = createHash("sha256").update(`${action}\n${body}`).digest("hex");
  const existing = database
    .query<{ requestHash: string; status: string; response: string | null }, [string]>(
      "SELECT request_hash AS requestHash, status, response FROM _mekka_auth_admin_idempotency WHERE key = ?",
    )
    .get(key);
  if (existing) {
    if (
      existing.requestHash !== requestHash ||
      existing.status !== "completed" ||
      existing.response === null
    ) {
      throw new AdminError("conflict", 409);
    }
    return jsonResponse(JSON.parse(existing.response) as unknown);
  }
  database
    .query<never, [string, string, string, number]>(
      "INSERT INTO _mekka_auth_admin_idempotency (key, action, request_hash, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    )
    .run(key, action, requestHash, Date.now());
  const result = await mutate(correlationId);
  const response = JSON.stringify(result);
  database
    .query<never, [number, string, string]>(
      "UPDATE _mekka_auth_admin_idempotency SET status = 'completed', completed_at = ?, response = ? WHERE key = ?",
    )
    .run(Date.now(), response, key);
  return jsonResponse(result);
}

async function audit(
  dependencies: AdminDependencies,
  context: AuthAdminContext,
  correlationId: string,
  event: Pick<AuthAdminAuditEvent, "action" | "targetId" | "details">,
): Promise<void> {
  await dependencies.options.auditSink.append(
    Object.freeze({
      ...event,
      actorId: context.capability.actorId,
      tenant: dependencies.tenant,
      occurredAt: dependencies.now(),
      correlationId,
    }),
  );
}

function revokeUserCredentials(database: Database, userId: string): void {
  database.transaction(() => {
    database
      .query<never, [string]>(
        "UPDATE _mekka_auth_refresh_token SET status = 'revoked' WHERE user_id = ?",
      )
      .run(userId);
    database.query<never, [string]>("DELETE FROM session WHERE userId = ?").run(userId);
  })();
}

function deleteUser(database: Database, userId: string): void {
  database.transaction(() => {
    const user = database
      .query<{ email: string }, [string]>("SELECT email FROM user WHERE id = ?")
      .get(userId);
    if (!user) throw new AdminError("validation", 404);
    database
      .query<never, [string]>(
        "UPDATE _mekka_auth_refresh_token SET status = 'revoked' WHERE user_id = ?",
      )
      .run(userId);
    database.query<never, [string]>("DELETE FROM session WHERE userId = ?").run(userId);
    database.query<never, [string]>("DELETE FROM account WHERE userId = ?").run(userId);
    database
      .query<never, [string, string, string, string, string]>(
        "DELETE FROM verification WHERE identifier IN (?, ?, ?, ?, ?)",
      )
      .run(
        user.email,
        `email-verification:${user.email}`,
        `forget-password:${user.email}`,
        `reset-password:${user.email}`,
        `password-reset:${user.email}`,
      );
    database.query<never, [string]>("DELETE FROM user WHERE id = ?").run(userId);
  })();
}

function initializeAdminTables(
  database: Database,
  enabledProviders: readonly AuthProvider[],
  redirectAllowlist: readonly string[],
): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS _mekka_auth_admin_setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT
  `);
  database.run(`
    CREATE TABLE IF NOT EXISTS _mekka_auth_admin_idempotency (
      key TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
      response TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    ) STRICT
  `);
  for (const provider of providers) {
    const enabled = enabledProviders.includes(provider);
    writeSettingIfMissing(
      database,
      `provider:${provider}`,
      JSON.stringify({ enabled, clientIdConfigured: enabled, clientSecretConfigured: enabled }),
    );
  }
  writeSettingIfMissing(database, "redirects", JSON.stringify(redirectAllowlist));
  writeSettingIfMissing(
    database,
    "template:email-verification",
    JSON.stringify({
      subject: "Verify your email",
      text: "Your verification code is {{ code }}. It expires in 5 minutes.",
    }),
  );
  writeSettingIfMissing(
    database,
    "template:password-reset",
    JSON.stringify({
      subject: "Reset your password",
      text: "Your password reset code is {{ code }}. It expires in 5 minutes.",
    }),
  );
}

function readSettings(database: Database) {
  return {
    providers: providers.map((provider) => ({
      provider,
      ...readProviderSetting(database, provider),
    })),
    redirectUrls: parseStoredStringArray(readSetting(database, "redirects")),
    templates: templates.map((template) => ({
      template,
      ...parseStoredTemplate(readSetting(database, `template:${template}`)),
    })),
  };
}

function readOAuthConfiguration(
  database: Database,
  override?: Readonly<{ provider: AuthProvider; enabled: boolean }>,
): AuthAdminOAuthConfiguration {
  return Object.freeze({
    providers: Object.freeze(
      providers.filter((provider) =>
        provider === override?.provider
          ? override.enabled
          : readProviderSetting(database, provider).enabled,
      ),
    ),
    redirectAllowlist: parseStoredStringArray(readSetting(database, "redirects")),
  });
}

function readEnabledProviders(database: Database): readonly AuthProvider[] {
  return readOAuthConfiguration(database).providers;
}

function readProviderSetting(database: Database, provider: AuthProvider) {
  const value = JSON.parse(readSetting(database, `provider:${provider}`)) as Record<
    string,
    unknown
  >;
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.clientIdConfigured !== "boolean" ||
    typeof value.clientSecretConfigured !== "boolean"
  ) {
    throw new AdminError("infrastructure", 503);
  }
  return {
    enabled: value.enabled,
    clientIdConfigured: value.clientIdConfigured,
    clientSecretConfigured: value.clientSecretConfigured,
  };
}

function writeProviderSetting(
  database: Database,
  provider: AuthProvider,
  value: Readonly<{
    enabled: boolean;
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
  }>,
): void {
  writeSetting(database, `provider:${provider}`, JSON.stringify(value));
}

function readSetting(database: Database, key: string): string {
  const value = database
    .query<{ value: string }, [string]>("SELECT value FROM _mekka_auth_admin_setting WHERE key = ?")
    .get(key)?.value;
  if (value === undefined) throw new AdminError("infrastructure", 503);
  return value;
}

function writeSetting(database: Database, key: string, value: string): void {
  database
    .query<never, [string, string, number]>(
      "INSERT INTO _mekka_auth_admin_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
}

function writeSettingIfMissing(database: Database, key: string, value: string): void {
  database
    .query<never, [string, string, number]>(
      "INSERT OR IGNORE INTO _mekka_auth_admin_setting (key, value, updated_at) VALUES (?, ?, ?)",
    )
    .run(key, value, Date.now());
}

function parseProviderUpdate(value: Record<string, unknown>) {
  if (typeof value.enabled !== "boolean") throw new AdminError("validation", 400);
  const clientId = optionalSecret(value.clientId);
  const clientSecret = optionalSecret(value.clientSecret);
  return { enabled: value.enabled, clientId, clientSecret };
}

function optionalSecret(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length < 3 || value.length > 4096) {
    throw new AdminError("validation", 400);
  }
  return value;
}

function parseRedirectUpdate(value: Record<string, unknown>): readonly string[] {
  if (!Array.isArray(value.urls) || value.urls.length > 32) throw new AdminError("validation", 400);
  const urls = value.urls.map((url) => parseRedirectUrl(url));
  if (new Set(urls).size !== urls.length) throw new AdminError("validation", 400);
  return Object.freeze(urls);
}

function parseRedirectUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new AdminError("validation", 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminError("validation", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    value !== url.toString()
  ) {
    throw new AdminError("validation", 400);
  }
  return url.toString();
}

function parseTemplateUpdate(value: Record<string, unknown>) {
  if (
    typeof value.subject !== "string" ||
    value.subject.trim().length === 0 ||
    value.subject.length > 160 ||
    /[\r\n]/.test(value.subject) ||
    typeof value.text !== "string" ||
    value.text.trim().length === 0 ||
    value.text.length > 16_384 ||
    !value.text.includes("{{ code }}")
  ) {
    throw new AdminError("validation", 400);
  }
  return { subject: value.subject.trim(), text: value.text };
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0 || text.length > maxBodyBytes) throw new AdminError("validation", 400);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AdminError("validation", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AdminError("validation", 400);
  }
  return value as Record<string, unknown>;
}

function parseStoredStringArray(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new AdminError("infrastructure", 503);
  }
  return Object.freeze([...parsed]);
}

function parseStoredTemplate(value: string): Readonly<{ subject: string; text: string }> {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("subject" in parsed) ||
    typeof parsed.subject !== "string" ||
    !("text" in parsed) ||
    typeof parsed.text !== "string"
  ) {
    throw new AdminError("infrastructure", 503);
  }
  return { subject: parsed.subject, text: parsed.text };
}

function parseBoundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AdminError("validation", 400);
  }
  return parsed;
}

function userExists(database: Database, userId: string): boolean {
  return (
    database
      .query<{ present: number }, [string]>("SELECT 1 AS present FROM user WHERE id = ?")
      .get(userId) !== null
  );
}

function toIsoString(value: Date | number | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AdminError("infrastructure", 503);
  return date.toISOString();
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

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminError("infrastructure", 503);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== value) {
    throw new AdminError("infrastructure", 503);
  }
  return value;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
