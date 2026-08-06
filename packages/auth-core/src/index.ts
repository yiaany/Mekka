import { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";
import { betterAuth } from "better-auth";
import { generateRandomString, makeSignature } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import {
  type AuthAdminContext,
  type AuthAdminHandler,
  type AuthAdminOAuthConfiguration,
  type AuthAdminOptions,
  createAuthAdminHandler,
} from "./admin";
import {
  type AuthJwtAuthority,
  AuthJwtError,
  type AuthSigningKeyStore,
  openAuthJwtAuthority,
  type VerifiedAuthAccessToken,
} from "./jwt";

export type {
  AuthAdminAction,
  AuthAdminAuditEvent,
  AuthAdminAuditSink,
  AuthAdminCapability,
  AuthAdminContext,
  AuthAdminOAuthConfiguration,
  AuthAdminOptions,
  AuthAdminSecretName,
  AuthAdminSecretStore,
} from "./admin";
export type {
  AuthSigningKeySet,
  AuthSigningKeyStore,
  IssuedAccessToken,
  VerifiedAuthAccessToken,
} from "./jwt";

export type AuthStoreMode =
  | Readonly<{ kind: "production" }>
  | Readonly<{ kind: "preview"; syntheticUsers?: readonly SyntheticAuthUser[] }>;

export type SyntheticAuthUser = Readonly<{
  id: string;
  email: string;
  name: string;
}>;

export type AuthSecretStore = Readonly<{
  readSecret(
    input: Readonly<{
      tenant: TenantIdentity;
      name:
        | "auth/session-secret"
        | "auth/oauth/google-client-id"
        | "auth/oauth/google-client-secret"
        | "auth/oauth/github-client-id"
        | "auth/oauth/github-client-secret";
    }>,
  ): Promise<string>;
}>;

export type AuthOAuthProvider = "google" | "github";

export type AuthOAuthConfiguration = Readonly<{
  providers: readonly AuthOAuthProvider[];
  redirectAllowlist: readonly string[];
}>;

export type AuthDomainOwnershipVerifier = Readonly<{
  isVerifiedOrigin(input: Readonly<{ tenant: TenantIdentity; origin: string }>): Promise<boolean>;
}>;

export type AuthEmailPurpose = "email-verification" | "password-reset";

export type AuthEmailMessage = Readonly<{
  to: string;
  subject: string;
  text: string;
  purpose: AuthEmailPurpose;
}>;

export type AuthEmailProvider = Readonly<{
  send(message: AuthEmailMessage): Promise<void>;
}>;

/** Local-only provider for integration tests and development mail inspection. */
export class LocalAuthEmailSink implements AuthEmailProvider {
  readonly messages: AuthEmailMessage[] = [];

  async send(message: AuthEmailMessage): Promise<void> {
    this.messages.push(Object.freeze({ ...message }));
  }
}

export type ProjectAuthServiceOptions = Readonly<{
  tenant: TenantIdentity;
  mode: AuthStoreMode;
  authStorageDirectory: string;
  publicOrigin: string;
  secretStore: AuthSecretStore;
  emailProvider: AuthEmailProvider;
  signingKeyStore: AuthSigningKeyStore;
  domainOwnershipVerifier: AuthDomainOwnershipVerifier;
  oauth?: AuthOAuthConfiguration;
  admin?: AuthAdminOptions;
  now?: () => number;
}>;

export type ProjectAuthPreviewStoreLifecycle = Readonly<{
  create(tenant: TenantIdentity, syntheticUsers: readonly SyntheticAuthUser[]): Promise<void>;
  delete(tenant: TenantIdentity): Promise<void>;
}>;

export type AuthBinding = Readonly<{
  issuer: string;
  audience: string;
  tenant: TenantIdentity;
  mode: AuthStoreMode["kind"];
}>;

export type ProjectAuthService = Readonly<{
  binding: AuthBinding;
  handleRequest(request: Request): Promise<Response>;
  handleAdminRequest(request: Request, context: AuthAdminContext): Promise<Response>;
  verifyAccessToken(token: string): Promise<VerifiedAuthAccessToken>;
  close(): void;
}>;

export type AuthServiceErrorCode =
  | "AUTH_CONFIG_INVALID"
  | "AUTH_SECRET_INVALID"
  | "AUTH_TENANT_MISMATCH"
  | "AUTH_REFRESH_TOKEN_INVALID"
  | "AUTH_ACCESS_TOKEN_INVALID"
  | "AUTH_OAUTH_INVALID";

export class AuthServiceError extends Error {
  readonly code: AuthServiceErrorCode;

  constructor(code: AuthServiceErrorCode, message: string) {
    super(message);
    this.name = "AuthServiceError";
    this.code = code;
  }
}

const sessionSecretName = "auth/session-secret" as const;
const syntheticUserIdPattern = /^[a-z][a-z0-9_-]{2,63}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const refreshTokenLifetimeMilliseconds = 1000 * 60 * 60 * 24 * 30;
const supportedOAuthProviders = new Set<AuthOAuthProvider>(["google", "github"]);

export async function openProjectAuthService(
  options: ProjectAuthServiceOptions,
): Promise<ProjectAuthService> {
  const tenant = parseTenantIdentity(options.tenant);
  const mode = validateMode(options.mode);
  const publicOrigin = parsePublicOrigin(options.publicOrigin);
  const oauth = validateOAuthConfiguration(mode, options.oauth);
  await verifyOwnedOrigins(
    tenant,
    publicOrigin,
    oauth.redirectAllowlist,
    options.domainOwnershipVerifier,
  );
  const databasePath = createStorePath(options.authStorageDirectory, tenant, mode.kind);
  const binding = createBinding(publicOrigin, tenant, mode.kind);
  const secret = await options.secretStore.readSecret({ tenant, name: sessionSecretName });
  const now = options.now ?? Date.now;

  if (secret.length < 32) {
    throw new AuthServiceError(
      "AUTH_SECRET_INVALID",
      "Auth session secret must be at least 32 characters long.",
    );
  }

  await mkdir(resolve(databasePath, ".."), { recursive: true });
  const database = new Database(databasePath, { strict: true });

  try {
    configureDatabase(database);
    const jwtAuthority = await openAuthJwtAuthority(binding, options.signingKeyStore, now);
    const createAuthRuntime = async (
      configuration: AuthAdminOAuthConfiguration,
      oauthSecretStore: OAuthSecretReader = options.secretStore,
    ) => {
      const socialProviders = await createSocialProviders(
        configuration.providers,
        oauthSecretStore,
        tenant,
      );
      return betterAuth({
        baseURL: binding.issuer,
        secret,
        database,
        emailAndPassword: {
          enabled: mode.kind === "production",
          autoSignIn: false,
          minPasswordLength: 12,
          maxPasswordLength: 128,
          requireEmailVerification: true,
          revokeSessionsOnPasswordReset: true,
        },
        emailVerification: {
          autoSignInAfterVerification: false,
        },
        socialProviders,
        account: {
          encryptOAuthTokens: true,
          accountLinking: {
            enabled: true,
            disableImplicitLinking: true,
            allowDifferentEmails: false,
            allowUnlinkingAll: false,
            trustedProviders: [],
          },
        },
        plugins:
          mode.kind === "production"
            ? [
                emailOTP({
                  allowedAttempts: 3,
                  disableSignUp: true,
                  expiresIn: 5 * 60,
                  rateLimit: { max: 3, window: 60 },
                  sendVerificationOnSignUp: true,
                  storeOTP: "hashed",
                  async sendVerificationOTP({ email, otp, type }): Promise<void> {
                    if (type === "email-verification") {
                      await options.emailProvider.send(
                        createVerificationEmail(database, email, otp),
                      );
                      return;
                    }

                    if (type === "forget-password") {
                      await options.emailProvider.send(
                        createPasswordResetEmail(database, email, otp),
                      );
                    }
                  },
                }),
              ]
            : [],
        logger: { disabled: true },
        rateLimit: { enabled: true, storage: "database" },
        trustedOrigins: [publicOrigin],
      });
    };
    let activeOAuth: AuthAdminOAuthConfiguration = oauth;
    let auth = await createAuthRuntime(activeOAuth);
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    initializeBinding(database, binding);
    initializeRefreshTokens(database);

    if (mode.kind === "preview") {
      seedSyntheticUsers(database, mode.syntheticUsers ?? []);
    }
    const adminOptions = options.admin;
    const adminHandler: AuthAdminHandler | undefined = adminOptions
      ? createAuthAdminHandler({
          database,
          tenant,
          enabledProviders: oauth.providers,
          redirectAllowlist: oauth.redirectAllowlist,
          options: adminOptions,
          async verifyRedirectOrigins(urls): Promise<boolean> {
            const origins = new Set(urls.map((url) => new URL(url).origin));
            for (const origin of origins) {
              if (!(await options.domainOwnershipVerifier.isVerifiedOrigin({ tenant, origin }))) {
                return false;
              }
            }
            return true;
          },
          async applyOAuthConfiguration(configuration): Promise<void> {
            const nextAuth = await createAuthRuntime(configuration, adminOptions.secretStore);
            auth = nextAuth;
            activeOAuth = configuration;
          },
          now,
        })
      : undefined;

    return Object.freeze({
      binding,
      async handleRequest(request: Request): Promise<Response> {
        const path = getAuthPath(request, binding);

        if (path === "/refresh" && request.method === "POST") {
          return await refreshSession(request, database, secret, jwtAuthority, now);
        }

        if (path === "/token" && request.method === "POST") {
          return await issueTokenPairForSession(
            request,
            (headers) => auth.api.getSession({ headers }),
            database,
            secret,
            jwtAuthority,
            now,
          );
        }

        if (path === "/.well-known/jwks.json" && request.method === "GET") {
          return new Response(JSON.stringify(jwtAuthority.jwks()), {
            headers: {
              "cache-control": "public, max-age=60, must-revalidate",
              "content-type": "application/json",
            },
          });
        }

        if (path === "/sign-in/social" && request.method === "POST") {
          const invalidOAuthRequest = await validateOAuthRequest(
            request,
            activeOAuth.providers,
            activeOAuth.redirectAllowlist,
          );
          if (invalidOAuthRequest) {
            return invalidOAuthRequest;
          }
        }

        const sessionBeforeSignOut =
          path === "/sign-out" && request.method === "POST"
            ? ((await auth.api.getSession({ headers: request.headers }))?.session.token ?? null)
            : null;
        const emailBeforePasswordReset =
          path === "/email-otp/reset-password" && request.method === "POST"
            ? await getRequestEmail(request)
            : null;
        const response = await auth.handler(request);

        if (response.ok && emailBeforePasswordReset) {
          revokeUserSessionsAndRefreshTokens(database, emailBeforePasswordReset);
        }

        if (response.ok && path === "/sign-out" && sessionBeforeSignOut) {
          revokeRefreshTokensForSession(database, sessionBeforeSignOut);
        }

        if (
          response.ok &&
          request.method === "POST" &&
          (path === "/sign-in/email" || path === "/sign-in/email-otp")
        ) {
          return await addTokenPair(response, database, secret, jwtAuthority, now);
        }

        return response;
      },
      async handleAdminRequest(request, context): Promise<Response> {
        if (!adminHandler) {
          return jsonResponse({ error: { code: "unsupported" } }, 501);
        }
        return await adminHandler(request, context);
      },
      async verifyAccessToken(token: string): Promise<VerifiedAuthAccessToken> {
        try {
          return await jwtAuthority.verifyAccessToken(token);
        } catch (error) {
          if (error instanceof AuthJwtError) {
            throw new AuthServiceError("AUTH_ACCESS_TOKEN_INVALID", error.message);
          }
          throw error;
        }
      },
      close(): void {
        database.close(false);
      },
    });
  } catch (error) {
    database.close(false);
    throw error;
  }
}

export async function deleteProjectAuthPreviewStore(
  authStorageDirectory: string,
  tenantInput: TenantIdentity,
): Promise<void> {
  const tenant = parseTenantIdentity(tenantInput);
  const databasePath = createStorePath(authStorageDirectory, tenant, "preview");
  const directory = resolve(databasePath, "..");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 50));
    }
  }
}

export function createProjectAuthPreviewStoreLifecycle(
  options: Omit<ProjectAuthServiceOptions, "tenant" | "mode">,
): ProjectAuthPreviewStoreLifecycle {
  return Object.freeze({
    async create(tenant, syntheticUsers): Promise<void> {
      const service = await openProjectAuthService({
        ...options,
        tenant,
        mode: {
          kind: "preview",
          ...(syntheticUsers.length > 0 ? { syntheticUsers } : {}),
        },
      });
      service.close();
    },
    async delete(tenant): Promise<void> {
      await deleteProjectAuthPreviewStore(options.authStorageDirectory, tenant);
    },
  });
}

function createVerificationEmail(database: Database, email: string, otp: string): AuthEmailMessage {
  const template = readConfiguredEmailTemplate(database, "email-verification", {
    subject: "Verify your email",
    text: "Your verification code is {{ code }}. It expires in 5 minutes.",
  });
  return Object.freeze({
    to: email,
    purpose: "email-verification",
    subject: template.subject,
    text: template.text.replaceAll("{{ code }}", otp),
  });
}

function createPasswordResetEmail(
  database: Database,
  email: string,
  otp: string,
): AuthEmailMessage {
  const template = readConfiguredEmailTemplate(database, "password-reset", {
    subject: "Reset your password",
    text: "Your password reset code is {{ code }}. It expires in 5 minutes.",
  });
  return Object.freeze({
    to: email,
    purpose: "password-reset",
    subject: template.subject,
    text: template.text.replaceAll("{{ code }}", otp),
  });
}

function readConfiguredEmailTemplate(
  database: Database,
  template: "email-verification" | "password-reset",
  fallback: Readonly<{ subject: string; text: string }>,
): Readonly<{ subject: string; text: string }> {
  try {
    const stored = database
      .query<{ value: string }, [string]>(
        "SELECT value FROM _mekka_auth_admin_setting WHERE key = ?",
      )
      .get(`template:${template}`)?.value;
    if (!stored) return fallback;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value !== "object" ||
      value === null ||
      !("subject" in value) ||
      typeof value.subject !== "string" ||
      !("text" in value) ||
      typeof value.text !== "string" ||
      !value.text.includes("{{ code }}")
    ) {
      return fallback;
    }
    return Object.freeze({ subject: value.subject, text: value.text });
  } catch {
    return fallback;
  }
}

function getAuthPath(request: Request, binding: AuthBinding): string {
  const path = new URL(request.url).pathname;
  const basePath = new URL(binding.issuer).pathname;
  return path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

async function getRequestEmail(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.clone().json();
    if (
      typeof body === "object" &&
      body !== null &&
      "email" in body &&
      typeof body.email === "string" &&
      emailPattern.test(body.email)
    ) {
      return body.email.toLowerCase();
    }
  } catch {
    return null;
  }

  return null;
}

async function addTokenPair(
  response: Response,
  database: Database,
  secret: string,
  jwtAuthority: AuthJwtAuthority,
  now: () => number,
): Promise<Response> {
  const body: unknown = await response.clone().json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("token" in body) ||
    typeof body.token !== "string"
  ) {
    return response;
  }

  const tokenPair = await issueTokenPair(database, secret, body.token, jwtAuthority, now);
  if (!tokenPair) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  const { token: _sessionToken, ...publicBody } = body;
  return new Response(JSON.stringify({ ...publicBody, ...tokenPair }), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function refreshSession(
  request: Request,
  database: Database,
  secret: string,
  jwtAuthority: AuthJwtAuthority,
  now: () => number,
): Promise<Response> {
  let refreshToken: string | null = null;
  try {
    const body: unknown = await request.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "refreshToken" in body &&
      typeof body.refreshToken === "string" &&
      body.refreshToken.length >= 32
    ) {
      refreshToken = body.refreshToken;
    }
  } catch {
    return refreshTokenError();
  }

  if (!refreshToken) {
    return refreshTokenError();
  }

  const signature = await makeSignature(refreshToken, secret);
  const current = database
    .query<RefreshTokenRecord, [string]>(`
      SELECT signature, session_id AS sessionId, user_id AS userId, expires_at AS expiresAt, status
      FROM _mekka_auth_refresh_token
      WHERE signature = ?
    `)
    .get(signature);

  if (!current) {
    return refreshTokenError();
  }

  if (current.status !== "active" || current.expiresAt <= now()) {
    revokeUserSessionsAndRefreshTokensById(database, current.userId);
    return refreshTokenError();
  }

  const session = database
    .query<AuthSessionRecord, [string, string]>(`
      SELECT id, token, userId, expiresAt
      FROM session
      WHERE id = ? AND userId = ?
    `)
    .get(current.sessionId, current.userId);
  const sessionExpiresAt = session ? toMilliseconds(session.expiresAt) : 0;
  if (!session || sessionExpiresAt <= now()) {
    revokeUserSessionsAndRefreshTokensById(database, current.userId);
    return refreshTokenError();
  }

  const nextSessionToken = generateRandomString(48);
  const nextRefreshToken = generateRandomString(48);
  const nextSignature = await makeSignature(nextRefreshToken, secret);
  const nextSessionId = generateRandomString(32);
  const expiresAt = Math.min(sessionExpiresAt, now() + refreshTokenLifetimeMilliseconds);
  const rotated = database.transaction(() => {
    const result = database
      .query<never, [number, string]>(`
        UPDATE _mekka_auth_refresh_token
        SET status = 'redeemed', redeemed_at = ?
        WHERE signature = ? AND status = 'active'
      `)
      .run(now(), signature);
    if (result.changes !== 1) {
      return false;
    }

    database
      .query<never, [string, string, string, number, number, number]>(`
        INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(nextSessionId, nextSessionToken, session.userId, sessionExpiresAt, now(), now());
    database
      .query<never, [string, string, string, number, number]>(`
        INSERT INTO _mekka_auth_refresh_token (signature, session_id, user_id, expires_at, status, created_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `)
      .run(nextSignature, nextSessionId, session.userId, expiresAt, now());
    database.query<never, [string]>("DELETE FROM session WHERE id = ?").run(session.id);
    return true;
  })();

  if (!rotated) {
    revokeUserSessionsAndRefreshTokensById(database, current.userId);
    return refreshTokenError();
  }

  const accessToken = await jwtAuthority.issueAccessToken(session.userId, nextSessionId);
  return jsonResponse({ ...accessToken, refreshToken: nextRefreshToken });
}

async function issueTokenPairForSession(
  request: Request,
  getSession: (
    headers: Headers,
  ) => Promise<Readonly<{ session: Readonly<{ token: string }> }> | null>,
  database: Database,
  secret: string,
  jwtAuthority: AuthJwtAuthority,
  now: () => number,
): Promise<Response> {
  const current = await getSession(request.headers);
  if (!current) {
    return jsonResponse({ code: "AUTH_ACCESS_TOKEN_INVALID" }, 401);
  }
  const tokenPair = await issueTokenPair(
    database,
    secret,
    current.session.token,
    jwtAuthority,
    now,
  );
  return tokenPair
    ? jsonResponse(tokenPair)
    : jsonResponse({ code: "AUTH_ACCESS_TOKEN_INVALID" }, 401);
}

async function issueTokenPair(
  database: Database,
  secret: string,
  sessionToken: string,
  jwtAuthority: AuthJwtAuthority,
  now: () => number,
): Promise<Readonly<{
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
  refreshToken: string;
}> | null> {
  const session = database
    .query<AuthSessionRecord, [string]>(`
      SELECT id, token, userId, expiresAt
      FROM session
      WHERE token = ?
    `)
    .get(sessionToken);
  if (!session || toMilliseconds(session.expiresAt) <= now()) {
    return null;
  }
  const refreshToken = await issueRefreshToken(database, secret, sessionToken, now);
  if (!refreshToken) {
    return null;
  }
  const accessToken = await jwtAuthority.issueAccessToken(session.userId, session.id);
  return Object.freeze({ ...accessToken, refreshToken });
}

async function issueRefreshToken(
  database: Database,
  secret: string,
  sessionToken: string,
  now: () => number,
): Promise<string | null> {
  const session = database
    .query<AuthSessionRecord, [string]>(`
      SELECT id, token, userId, expiresAt
      FROM session
      WHERE token = ?
    `)
    .get(sessionToken);
  const sessionExpiresAt = session ? toMilliseconds(session.expiresAt) : 0;
  if (!session) {
    return null;
  }

  const refreshToken = generateRandomString(48);
  const signature = await makeSignature(refreshToken, secret);
  database
    .query<never, [string, string, string, number, number]>(`
      INSERT INTO _mekka_auth_refresh_token (signature, session_id, user_id, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `)
    .run(
      signature,
      session.id,
      session.userId,
      Math.min(sessionExpiresAt, now() + refreshTokenLifetimeMilliseconds),
      now(),
    );
  return refreshToken;
}

function refreshTokenError(): Response {
  return jsonResponse({ code: "AUTH_REFRESH_TOKEN_INVALID" }, 401);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function initializeRefreshTokens(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS _mekka_auth_refresh_token (
      signature TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'redeemed', 'revoked')),
      created_at INTEGER NOT NULL,
      redeemed_at INTEGER
    ) STRICT
  `);
  database.run(
    "CREATE INDEX IF NOT EXISTS _mekka_auth_refresh_token_user_idx ON _mekka_auth_refresh_token (user_id)",
  );
}

function revokeRefreshTokensForSession(database: Database, sessionToken: string): void {
  database
    .query<never, [string]>(`
      UPDATE _mekka_auth_refresh_token
      SET status = 'revoked'
      WHERE session_id = (SELECT id FROM session WHERE token = ?)
    `)
    .run(sessionToken);
}

function revokeUserSessionsAndRefreshTokens(database: Database, email: string): void {
  const user = database
    .query<{ id: string }, [string]>("SELECT id FROM user WHERE email = ?")
    .get(email);
  if (user) {
    revokeUserSessionsAndRefreshTokensById(database, user.id);
  }
}

function revokeUserSessionsAndRefreshTokensById(database: Database, userId: string): void {
  const revoke = database.transaction(() => {
    database
      .query<never, [string]>(
        "UPDATE _mekka_auth_refresh_token SET status = 'revoked' WHERE user_id = ?",
      )
      .run(userId);
    database.query<never, [string]>("DELETE FROM session WHERE userId = ?").run(userId);
  });
  revoke();
}

type AuthSessionRecord = Readonly<{
  id: string;
  token: string;
  userId: string;
  expiresAt: Date | number | string;
}>;

type RefreshTokenRecord = Readonly<{
  signature: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
  status: "active" | "redeemed" | "revoked";
}>;

function toMilliseconds(value: Date | number | string): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  return Date.parse(value);
}

function validateOAuthConfiguration(
  mode: AuthStoreMode,
  configuration: AuthOAuthConfiguration | undefined,
): Readonly<{ providers: readonly AuthOAuthProvider[]; redirectAllowlist: readonly string[] }> {
  if (!configuration) {
    return Object.freeze({ providers: Object.freeze([]), redirectAllowlist: Object.freeze([]) });
  }
  if (mode.kind !== "production") {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      "OAuth is unavailable in preview auth stores.",
    );
  }
  const providers = [...configuration.providers];
  if (
    providers.length === 0 ||
    providers.length > supportedOAuthProviders.size ||
    providers.some((provider) => !supportedOAuthProviders.has(provider)) ||
    new Set(providers).size !== providers.length
  ) {
    throw new AuthServiceError("AUTH_CONFIG_INVALID", "OAuth provider configuration is invalid.");
  }
  const redirectAllowlist = configuration.redirectAllowlist.map(parseOAuthRedirectUrl);
  if (
    redirectAllowlist.length === 0 ||
    redirectAllowlist.length > 32 ||
    new Set(redirectAllowlist).size !== redirectAllowlist.length
  ) {
    throw new AuthServiceError("AUTH_CONFIG_INVALID", "OAuth redirect allowlist is invalid.");
  }
  return Object.freeze({
    providers: Object.freeze(providers),
    redirectAllowlist: Object.freeze(redirectAllowlist),
  });
}

function parseOAuthRedirectUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthServiceError("AUTH_CONFIG_INVALID", "OAuth redirect URL must be absolute.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    value !== url.toString()
  ) {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      "OAuth redirect URL must be a canonical HTTPS URL without credentials or fragment.",
    );
  }
  return url.toString();
}

async function verifyOwnedOrigins(
  tenant: TenantIdentity,
  publicOrigin: string,
  redirectAllowlist: readonly string[],
  verifier: AuthDomainOwnershipVerifier,
): Promise<void> {
  const origins = new Set([
    publicOrigin,
    ...redirectAllowlist.map((redirect) => new URL(redirect).origin),
  ]);
  for (const origin of origins) {
    if (!(await verifier.isVerifiedOrigin({ tenant, origin }))) {
      throw new AuthServiceError(
        "AUTH_CONFIG_INVALID",
        "Auth origin ownership has not been verified for this tenant.",
      );
    }
  }
}

async function createSocialProviders(
  providers: readonly AuthOAuthProvider[],
  secretStore: OAuthSecretReader,
  tenant: TenantIdentity,
) {
  const socialProviders: {
    google?: Readonly<{ clientId: string; clientSecret: string }>;
    github?: Readonly<{ clientId: string; clientSecret: string }>;
  } = {};

  if (providers.includes("google")) {
    socialProviders.google = Object.freeze({
      clientId: await readOAuthSecret(secretStore, tenant, "auth/oauth/google-client-id"),
      clientSecret: await readOAuthSecret(secretStore, tenant, "auth/oauth/google-client-secret"),
    });
  }
  if (providers.includes("github")) {
    socialProviders.github = Object.freeze({
      clientId: await readOAuthSecret(secretStore, tenant, "auth/oauth/github-client-id"),
      clientSecret: await readOAuthSecret(secretStore, tenant, "auth/oauth/github-client-secret"),
    });
  }
  return Object.freeze(socialProviders);
}

async function readOAuthSecret(
  secretStore: OAuthSecretReader,
  tenant: TenantIdentity,
  name: Exclude<Parameters<AuthSecretStore["readSecret"]>[0]["name"], "auth/session-secret">,
): Promise<string> {
  const value = await secretStore.readSecret({ tenant, name });
  if (value.length < 3) {
    throw new AuthServiceError("AUTH_SECRET_INVALID", "OAuth provider secret is invalid.");
  }
  return value;
}

type OAuthSecretReader = Readonly<{
  readSecret(
    input: Readonly<{
      tenant: TenantIdentity;
      name: Exclude<Parameters<AuthSecretStore["readSecret"]>[0]["name"], "auth/session-secret">;
    }>,
  ): Promise<string>;
}>;

async function validateOAuthRequest(
  request: Request,
  enabledProviders: readonly AuthOAuthProvider[],
  redirectAllowlist: readonly string[],
): Promise<Response | null> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return oauthRequestError();
  }
  if (typeof body !== "object" || body === null) {
    return oauthRequestError();
  }
  const input = body as Record<string, unknown>;
  if (
    typeof input.provider !== "string" ||
    !enabledProviders.includes(input.provider as AuthOAuthProvider) ||
    "idToken" in input ||
    "scopes" in input ||
    "additionalData" in input
  ) {
    return oauthRequestError();
  }
  for (const field of ["callbackURL", "newUserCallbackURL", "errorCallbackURL"] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== "string" || !redirectAllowlist.includes(value))) {
      return oauthRequestError();
    }
  }
  if (typeof input.callbackURL !== "string") {
    return oauthRequestError();
  }
  return null;
}

function oauthRequestError(): Response {
  return jsonResponse({ code: "AUTH_OAUTH_INVALID" }, 400);
}

function validateMode(mode: AuthStoreMode): AuthStoreMode {
  if (mode.kind === "production") {
    return Object.freeze({ kind: "production" });
  }

  if (mode.kind !== "preview") {
    throw new AuthServiceError("AUTH_CONFIG_INVALID", "Auth store mode is invalid.");
  }

  const syntheticUsers = mode.syntheticUsers ?? [];
  const ids = new Set<string>();
  const emails = new Set<string>();

  for (const user of syntheticUsers) {
    if (
      !syntheticUserIdPattern.test(user.id) ||
      !emailPattern.test(user.email) ||
      user.name.trim().length === 0 ||
      user.name.length > 256 ||
      ids.has(user.id) ||
      emails.has(user.email.toLowerCase())
    ) {
      throw new AuthServiceError("AUTH_CONFIG_INVALID", "Synthetic preview user is invalid.");
    }

    ids.add(user.id);
    emails.add(user.email.toLowerCase());
  }

  return Object.freeze({
    kind: "preview",
    ...(syntheticUsers.length > 0 ? { syntheticUsers: Object.freeze([...syntheticUsers]) } : {}),
  });
}

function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      "Auth public origin must be an absolute URL.",
    );
  }

  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/") {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      "Auth public origin must contain only an HTTP(S) origin.",
    );
  }

  return url.origin;
}

function createStorePath(
  rootDirectory: string,
  tenant: TenantIdentity,
  mode: AuthStoreMode["kind"],
): string {
  const root = resolve(rootDirectory);
  const scope = [
    "organizations",
    tenant.organizationId,
    "projects",
    tenant.projectId,
    "environments",
    tenant.environmentId,
    "branches",
    tenant.branchId,
    "generations",
    String(tenant.generation),
    mode,
    "auth.sqlite",
  ];
  const path = resolve(root, ...scope);
  const pathFromRoot = relative(root, path);

  if (
    pathFromRoot.length === 0 ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith("..\\") ||
    pathFromRoot.startsWith("../")
  ) {
    throw new AuthServiceError(
      "AUTH_CONFIG_INVALID",
      "Auth store path escaped its approved directory.",
    );
  }

  return path;
}

function createBinding(
  publicOrigin: string,
  tenant: TenantIdentity,
  mode: AuthStoreMode["kind"],
): AuthBinding {
  const scope = [
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ].join("/");

  return Object.freeze({
    issuer: `${publicOrigin}/auth/${scope}`,
    audience: `mekka:${tenant.organizationId}:${tenant.projectId}:${tenant.environmentId}:${tenant.branchId}:${tenant.generation}`,
    tenant,
    mode,
  });
}

function configureDatabase(database: Database): void {
  database.run("PRAGMA foreign_keys = ON");
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = NORMAL");
  database.run("PRAGMA busy_timeout = 1000");
}

function initializeBinding(database: Database, binding: AuthBinding): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS _mekka_auth_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('production', 'preview')),
      issuer TEXT NOT NULL,
      audience TEXT NOT NULL
    ) STRICT
  `);

  const current = database
    .query<
      {
        organizationId: string;
        projectId: string;
        environmentId: string;
        branchId: string;
        generation: number;
        mode: AuthStoreMode["kind"];
        issuer: string;
        audience: string;
      },
      []
    >(`
      SELECT
        organization_id AS organizationId,
        project_id AS projectId,
        environment_id AS environmentId,
        branch_id AS branchId,
        generation,
        mode,
        issuer,
        audience
      FROM _mekka_auth_binding
      WHERE singleton = 1
    `)
    .get();

  if (current === null || current === undefined) {
    database
      .query<never, [string, string, string, string, number, string, string, string]>(`
        INSERT INTO _mekka_auth_binding (
          singleton,
          organization_id,
          project_id,
          environment_id,
          branch_id,
          generation,
          mode,
          issuer,
          audience
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        binding.tenant.organizationId,
        binding.tenant.projectId,
        binding.tenant.environmentId,
        binding.tenant.branchId,
        binding.tenant.generation,
        binding.mode,
        binding.issuer,
        binding.audience,
      );
    return;
  }

  if (
    current.organizationId !== binding.tenant.organizationId ||
    current.projectId !== binding.tenant.projectId ||
    current.environmentId !== binding.tenant.environmentId ||
    current.branchId !== binding.tenant.branchId ||
    current.generation !== binding.tenant.generation ||
    current.mode !== binding.mode ||
    current.issuer !== binding.issuer ||
    current.audience !== binding.audience
  ) {
    throw new AuthServiceError("AUTH_TENANT_MISMATCH", "Auth store binding does not match tenant.");
  }
}

function seedSyntheticUsers(database: Database, users: readonly SyntheticAuthUser[]): void {
  const insertUser = database.query<never, [string, string, string, number, number]>(`
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, emailVerified = 1,
      updatedAt = excluded.updatedAt
  `);
  const now = Date.now();

  const seed = database.transaction(() => {
    for (const user of users) {
      insertUser.run(user.id, user.name, user.email.toLowerCase(), now, now);
    }
  });

  seed();
}
