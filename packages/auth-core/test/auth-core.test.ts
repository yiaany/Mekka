import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type JWK, SignJWT } from "jose";
import {
  type AuthAdminAuditEvent,
  type AuthAdminContext,
  type AuthSecretStore,
  AuthServiceError,
  type AuthSigningKeySet,
  type AuthSigningKeyStore,
  createProjectAuthPreviewStoreLifecycle,
  LocalAuthEmailSink,
  openProjectAuthService,
} from "../src/index";

const temporaryDirectories: string[] = [];
const secretStore: AuthSecretStore = {
  async readSecret({ name }): Promise<string> {
    const values = {
      "auth/session-secret": "test-only-auth-secret-that-is-long-enough-to-be-valid",
      "auth/oauth/google-client-id": "google-client",
      "auth/oauth/google-client-secret": "google-secret",
      "auth/oauth/github-client-id": "github-client",
      "auth/oauth/github-client-secret": "github-secret",
    } as const;
    return values[name];
  },
};
const domainOwnershipVerifier = {
  async isVerifiedOrigin(): Promise<boolean> {
    return true;
  },
};
const defaultSigningKeySet = await createSigningKeySet("signing-key-0001");
const signingKeyStore = signingKeyStoreFor(defaultSigningKeySet);

function securityOptions(): Readonly<{
  signingKeyStore: AuthSigningKeyStore;
  domainOwnershipVerifier: typeof domainOwnershipVerifier;
}> {
  return { signingKeyStore, domainOwnershipVerifier };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

function tenant(projectId: string, branchId = "main"): TenantIdentity {
  return parseTenantIdentity({
    organizationId: "org-alpha",
    projectId,
    environmentId: "prod-env",
    branchId,
    generation: 1,
  });
}

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSigningKeySet(kid: string): Promise<AuthSigningKeySet> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return Object.freeze({
    current: Object.freeze({
      kid,
      privateKeyPkcs8: await exportPKCS8(privateKey),
      publicKeyJwk: await exportJWK(publicKey),
    }),
  });
}

function signingKeyStoreFor(keySet: AuthSigningKeySet): AuthSigningKeyStore {
  return {
    async readSigningKeySet(): Promise<AuthSigningKeySet> {
      return keySet;
    },
  };
}

function databasePath(
  directory: string,
  tenantIdentity: TenantIdentity,
  mode: "production" | "preview",
): string {
  return join(
    directory,
    "organizations",
    tenantIdentity.organizationId,
    "projects",
    tenantIdentity.projectId,
    "environments",
    tenantIdentity.environmentId,
    "branches",
    tenantIdentity.branchId,
    "generations",
    String(tenantIdentity.generation),
    mode,
    "auth.sqlite",
  );
}

function authRequest(
  service: Awaited<ReturnType<typeof openProjectAuthService>>,
  path: string,
  body: Record<string, string>,
): Request {
  return new Request(`${service.binding.issuer}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://auth.example.test",
    },
    method: "POST",
  });
}

function adminContext(tenantIdentity: TenantIdentity): AuthAdminContext {
  return {
    capability: {
      tenant: tenantIdentity,
      actorId: "studio-admin",
      actions: ["auth:admin"],
      expiresAt: Date.now() + 60_000,
    },
    csrfToken: "csrf-token-value-that-is-long-enough",
  };
}

function adminRequest(
  service: Awaited<ReturnType<typeof openProjectAuthService>>,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  idempotencyKey = "auth-admin-request-0001",
): Request {
  return new Request(`${service.binding.issuer}/admin${path}`, {
    method,
    headers: {
      origin: "https://auth.example.test",
      "x-mekka-csrf-token": "csrf-token-value-that-is-long-enough",
      "x-correlation-id": "correlation-auth-admin-0001",
      "idempotency-key": idempotencyKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function otpFromMessage(message: string): string {
  const match = /code is (\d{6})\./.exec(message);
  if (!match) {
    throw new Error("Expected a six-digit OTP in the test email.");
  }
  return match[1];
}

function cookieFromSetCookie(value: string | null, cookieName: string): string {
  const match = new RegExp(`(?:__Secure-)?better-auth\\.${cookieName}=([^;,\\s]+)`).exec(
    value ?? "",
  );
  if (!match) {
    throw new Error(`Expected Better Auth ${cookieName} cookie.`);
  }
  return `${match[0].split("=")[0]}=${match[1]}`;
}

async function registerVerifiedUser(
  service: Awaited<ReturnType<typeof openProjectAuthService>>,
  emailProvider: LocalAuthEmailSink,
  email: string,
): Promise<Readonly<{ accessToken: string; refreshToken: string }>> {
  const password = "correct-horse-battery-staple";
  const signUp = await service.handleRequest(
    authRequest(service, "/sign-up/email", { email, name: "Member", password }),
  );
  expect(signUp.status).toBe(200);
  const message = emailProvider.messages.at(-1);
  if (!message) {
    throw new Error("Expected a verification message.");
  }
  const verified = await service.handleRequest(
    authRequest(service, "/email-otp/verify-email", { email, otp: otpFromMessage(message.text) }),
  );
  expect(verified.status).toBe(200);
  const login = await service.handleRequest(
    authRequest(service, "/sign-in/email", { email, password }),
  );
  expect(login.status).toBe(200);
  return (await login.json()) as Readonly<{ accessToken: string; refreshToken: string }>;
}

describe("Studio Auth administration", () => {
  test("deletes a user transactionally, invalidates credentials, audits, and replays the result", async () => {
    const directory = await createFixture();
    const projectTenant = tenant("studio-auth-delete");
    const emailProvider = new LocalAuthEmailSink();
    const auditEvents: AuthAdminAuditEvent[] = [];
    const service = await openProjectAuthService({
      tenant: projectTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      ...securityOptions(),
      admin: {
        studioOrigin: "https://auth.example.test",
        secretStore: {
          readSecret: ({ name }) => secretStore.readSecret({ tenant: projectTenant, name }),
          async writeSecrets(): Promise<void> {},
        },
        auditSink: {
          async append(event): Promise<void> {
            auditEvents.push(event);
          },
        },
      },
    });

    try {
      const email = "delete-user@example.test";
      const password = "correct-horse-battery-staple";
      const tokens = await registerVerifiedUser(service, emailProvider, email);
      const verified = await service.verifyAccessToken(tokens.accessToken);
      const request = () =>
        service.handleAdminRequest(
          adminRequest(
            service,
            `/users/${verified.userId}`,
            "DELETE",
            { confirmation: verified.userId },
            "auth-user-delete-0001",
          ),
          adminContext(projectTenant),
        );

      const first = await request();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ deleted: true, userId: verified.userId });
      const replay = await request();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ deleted: true, userId: verified.userId });
      expect(service.isSessionActive(verified.sessionId, verified.userId)).toBe(false);
      expect(
        (
          await service.handleRequest(
            authRequest(service, "/refresh", {
              refreshToken: tokens.refreshToken,
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (await service.handleRequest(authRequest(service, "/sign-in/email", { email, password })))
          .status,
      ).toBe(401);

      const database = new Database(databasePath(directory, projectTenant, "production"));
      try {
        for (const [table, column] of [
          ["user", "id"],
          ["account", "userId"],
          ["session", "userId"],
        ] as const) {
          expect(
            database
              .query<{ count: number }, [string]>(
                `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
              )
              .get(verified.userId)?.count,
          ).toBe(0);
        }
        expect(
          database
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) AS count FROM _mekka_auth_refresh_token WHERE user_id = ? AND status != 'revoked'",
            )
            .get(verified.userId)?.count,
        ).toBe(0);
      } finally {
        database.close(false);
      }
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]).toMatchObject({
        action: "auth.user.delete.requested",
        targetId: verified.userId,
      });
    } finally {
      service.close();
    }
  });

  test("isolates users, writes provider secrets safely, validates redirects and revokes sessions with audit", async () => {
    const directory = await createFixture();
    const projectTenant = tenant("studio-auth-project");
    const emailProvider = new LocalAuthEmailSink();
    const auditEvents: AuthAdminAuditEvent[] = [];
    const writtenSecrets: Array<{ name: string; value: string }> = [];
    const oauthSecrets = new Map<string, string>([
      ["auth/oauth/google-client-id", "google-client"],
      ["auth/oauth/google-client-secret", "google-secret"],
      ["auth/oauth/github-client-id", "github-client"],
      ["auth/oauth/github-client-secret", "github-secret"],
    ]);
    const service = await openProjectAuthService({
      tenant: projectTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      ...securityOptions(),
      admin: {
        studioOrigin: "https://auth.example.test",
        secretStore: {
          async readSecret({ name }): Promise<string> {
            const value = oauthSecrets.get(name);
            if (!value) throw new Error(`Missing test OAuth secret: ${name}`);
            return value;
          },
          async writeSecrets(inputs): Promise<void> {
            for (const { name, value } of inputs) {
              writtenSecrets.push({ name, value });
              oauthSecrets.set(name, value);
            }
          },
        },
        auditSink: {
          async append(event): Promise<void> {
            auditEvents.push(event);
          },
        },
      },
    });

    try {
      const tokens = await registerVerifiedUser(service, emailProvider, "studio-user@example.test");
      const context = adminContext(projectTenant);
      const usersResponse = await service.handleAdminRequest(
        adminRequest(service, "/users"),
        context,
      );
      expect(usersResponse.status).toBe(200);
      const usersBody = (await usersResponse.json()) as {
        users: Array<{ id: string; email: string; sessionCount: number }>;
      };
      expect(usersBody.users).toHaveLength(1);
      expect(usersBody.users[0]).toMatchObject({
        email: "studio-user@example.test",
        sessionCount: 1,
      });
      const userId = usersBody.users[0]?.id;
      if (!userId) throw new Error("Expected an Auth user id.");

      const crossProject = await service.handleAdminRequest(
        adminRequest(service, "/users"),
        adminContext(tenant("other-project")),
      );
      expect(crossProject.status).toBe(403);

      const providerResponse = await service.handleAdminRequest(
        adminRequest(
          service,
          "/providers/google",
          "PUT",
          { enabled: true, clientId: "new-google-client", clientSecret: "new-google-secret" },
          "auth-provider-update-0001",
        ),
        context,
      );
      expect(providerResponse.status).toBe(200);
      expect(await providerResponse.json()).toEqual({
        enabled: true,
        clientIdConfigured: true,
        clientSecretConfigured: true,
      });
      expect(writtenSecrets).toEqual([
        { name: "auth/oauth/google-client-id", value: "new-google-client" },
        { name: "auth/oauth/google-client-secret", value: "new-google-secret" },
      ]);
      const settings = await service.handleAdminRequest(
        adminRequest(service, "/settings"),
        context,
      );
      const settingsText = await settings.text();
      expect(settingsText).not.toContain("new-google-client");
      expect(settingsText).not.toContain("new-google-secret");

      const invalidRedirect = await service.handleAdminRequest(
        adminRequest(
          service,
          "/redirects",
          "PUT",
          { urls: ["https://app.example.test/callback#fragment"] },
          "auth-redirect-update-0001",
        ),
        context,
      );
      expect(invalidRedirect.status).toBe(400);
      const validRedirect = await service.handleAdminRequest(
        adminRequest(
          service,
          "/redirects",
          "PUT",
          { urls: ["https://app.example.test/callback"] },
          "auth-redirect-update-0002",
        ),
        context,
      );
      expect(validRedirect.status).toBe(200);
      const liveOAuthRequest = await service.handleRequest(
        authRequest(service, "/sign-in/social", {
          provider: "google",
          callbackURL: "https://app.example.test/callback",
        }),
      );
      expect(liveOAuthRequest.status).toBe(200);

      const invalidTemplate = await service.handleAdminRequest(
        adminRequest(
          service,
          "/templates/password-reset",
          "PUT",
          { subject: "Reset", text: "Missing required token" },
          "auth-template-update-0001",
        ),
        context,
      );
      expect(invalidTemplate.status).toBe(400);
      const validTemplate = await service.handleAdminRequest(
        adminRequest(
          service,
          "/templates/password-reset",
          "PUT",
          { subject: "Mekka password reset", text: "Use {{ code }} to reset your password." },
          "auth-template-update-0002",
        ),
        context,
      );
      expect(validTemplate.status).toBe(200);
      const resetRequest = await service.handleRequest(
        authRequest(service, "/email-otp/request-password-reset", {
          email: "studio-user@example.test",
        }),
      );
      expect(resetRequest.status).toBe(200);
      expect(emailProvider.messages.at(-1)).toMatchObject({
        subject: "Mekka password reset",
        purpose: "password-reset",
      });
      expect(emailProvider.messages.at(-1)?.text).toMatch(/^Use \d{6} to reset your password\.$/);

      const missingConfirmation = await service.handleAdminRequest(
        adminRequest(
          service,
          `/users/${userId}/revoke`,
          "POST",
          { confirmation: "wrong-user" },
          "auth-user-revoke-0001",
        ),
        context,
      );
      expect(missingConfirmation.status).toBe(400);
      const missingUser = await service.handleAdminRequest(
        adminRequest(
          service,
          "/users/missing-user/revoke",
          "POST",
          { confirmation: "missing-user" },
          "auth-user-revoke-0000",
        ),
        context,
      );
      expect(missingUser.status).toBe(404);
      const revokeRequest = () =>
        service.handleAdminRequest(
          adminRequest(
            service,
            `/users/${userId}/revoke`,
            "POST",
            { confirmation: userId },
            "auth-user-revoke-0002",
          ),
          context,
        );
      expect((await revokeRequest()).status).toBe(200);
      expect((await revokeRequest()).status).toBe(200);
      const refreshed = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken: tokens.refreshToken }),
      );
      expect(refreshed.status).toBe(401);

      expect(auditEvents.map((event) => event.action)).toEqual([
        "auth.provider.update.requested",
        "auth.redirects.update.requested",
        "auth.template.update.requested",
        "auth.user.sessions.revoke.requested",
      ]);
      expect(JSON.stringify(auditEvents)).not.toContain("new-google-secret");
    } finally {
      service.close();
    }
  });

  test("rejects mutations without matching CSRF and admin capability", async () => {
    const directory = await createFixture();
    const projectTenant = tenant("studio-auth-csrf");
    const service = await openProjectAuthService({
      tenant: projectTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
      admin: {
        studioOrigin: "https://auth.example.test",
        secretStore: {
          readSecret: ({ name }) => secretStore.readSecret({ tenant: projectTenant, name }),
          async writeSecrets(): Promise<void> {},
        },
        auditSink: { async append(): Promise<void> {} },
      },
    });
    try {
      const request = adminRequest(
        service,
        "/redirects",
        "PUT",
        { urls: [] },
        "auth-csrf-rejection-0001",
      );
      request.headers.set("x-mekka-csrf-token", "wrong-csrf-token-value-that-is-long");
      expect((await service.handleAdminRequest(request, adminContext(projectTenant))).status).toBe(
        403,
      );
      const expired = adminContext(projectTenant);
      expect(
        (
          await service.handleAdminRequest(adminRequest(service, "/users"), {
            ...expired,
            capability: { ...expired.capability, expiresAt: 0 },
          })
        ).status,
      ).toBe(403);
    } finally {
      service.close();
    }
  });

  test("rejects redirect origins that are not verified for the project", async () => {
    const directory = await createFixture();
    const projectTenant = tenant("studio-auth-redirect-ownership");
    const auditEvents: AuthAdminAuditEvent[] = [];
    const service = await openProjectAuthService({
      tenant: projectTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      signingKeyStore,
      domainOwnershipVerifier: {
        async isVerifiedOrigin({ origin }): Promise<boolean> {
          return origin === "https://auth.example.test";
        },
      },
      admin: {
        studioOrigin: "https://auth.example.test",
        secretStore: {
          readSecret: ({ name }) => secretStore.readSecret({ tenant: projectTenant, name }),
          async writeSecrets(): Promise<void> {},
        },
        auditSink: {
          async append(event): Promise<void> {
            auditEvents.push(event);
          },
        },
      },
    });
    try {
      const response = await service.handleAdminRequest(
        adminRequest(
          service,
          "/redirects",
          "PUT",
          { urls: ["https://unverified.example.test/callback"] },
          "auth-unverified-redirect-0001",
        ),
        adminContext(projectTenant),
      );
      expect(response.status).toBe(400);
      expect(auditEvents).toHaveLength(0);

      const settings = await service.handleAdminRequest(
        adminRequest(service, "/settings"),
        adminContext(projectTenant),
      );
      expect(await settings.json()).toMatchObject({ redirectUrls: [] });
    } finally {
      service.close();
    }
  });

  test("reserves failed idempotency keys before uncertain external side effects", async () => {
    const directory = await createFixture();
    const projectTenant = tenant("studio-auth-idempotency");
    let secretWrites = 0;
    const auditEvents: AuthAdminAuditEvent[] = [];
    const service = await openProjectAuthService({
      tenant: projectTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
      admin: {
        studioOrigin: "https://auth.example.test",
        secretStore: {
          readSecret: ({ name }) => secretStore.readSecret({ tenant: projectTenant, name }),
          async writeSecrets(): Promise<void> {
            secretWrites += 1;
            throw new Error("uncertain secret-store result");
          },
        },
        auditSink: {
          async append(event): Promise<void> {
            auditEvents.push(event);
          },
        },
      },
    });
    try {
      const request = () =>
        service.handleAdminRequest(
          adminRequest(
            service,
            "/providers/google",
            "PUT",
            { enabled: true, clientId: "google-client", clientSecret: "google-secret" },
            "auth-provider-failure-0001",
          ),
          adminContext(projectTenant),
        );
      expect((await request()).status).toBe(503);
      expect((await request()).status).toBe(409);
      expect(secretWrites).toBe(1);
      expect(auditEvents).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});

async function signTestAccessToken(
  keySet: AuthSigningKeySet,
  tenantIdentity: TenantIdentity,
  issuer: string,
  audience: string,
  now: number,
): Promise<string> {
  const privateKey = await importPKCS8(keySet.current.privateKeyPkcs8, "ES256");
  return new SignJWT({
    role: "authenticated",
    sid: "session-test-001",
    tenant: {
      organizationId: tenantIdentity.organizationId,
      projectId: tenantIdentity.projectId,
      environmentId: tenantIdentity.environmentId,
      branchId: tenantIdentity.branchId,
      generation: tenantIdentity.generation,
    },
  })
    .setProtectedHeader({ alg: "ES256", kid: keySet.current.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("user-test-001")
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + 15 * 60)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

describe("project auth service", () => {
  test("isolates Better Auth users and sessions by the full tenant scope", async () => {
    const directory = await createFixture();
    const firstTenant = tenant("project-one");
    const secondTenant = tenant("project-two");
    const first = await openProjectAuthService({
      tenant: firstTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
    });
    const second = await openProjectAuthService({
      tenant: secondTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
    });

    try {
      const firstDatabase = new Database(databasePath(directory, firstTenant, "production"));
      try {
        firstDatabase
          .query<never, [string, string, string, number, number, number]>(`
            INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run("user-one", "First user", "first@example.test", 1, Date.now(), Date.now());
      } finally {
        firstDatabase.close(false);
      }

      const secondDatabase = new Database(databasePath(directory, secondTenant, "production"));
      try {
        expect(
          secondDatabase.query<{ count: number }, []>("SELECT count(*) AS count FROM user").get(),
        ).toEqual({
          count: 0,
        });
      } finally {
        secondDatabase.close(false);
      }

      expect(first.binding.audience).not.toBe(second.binding.audience);
      expect(first.binding.issuer).not.toBe(second.binding.issuer);
    } finally {
      first.close();
      second.close();
    }
  });

  test("creates preview auth storage without production accounts, sessions, or credentials", async () => {
    const directory = await createFixture();
    const productionTenant = tenant("project-one", "main");
    const previewTenant = tenant("project-one", "preview-42");
    const production = await openProjectAuthService({
      tenant: productionTenant,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
    });

    try {
      const productionDatabase = new Database(
        databasePath(directory, productionTenant, "production"),
      );
      try {
        productionDatabase
          .query<never, [string, string, string, number, number, number]>(`
            INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            "prod-user",
            "Production user",
            "production@example.test",
            1,
            Date.now(),
            Date.now(),
          );
      } finally {
        productionDatabase.close(false);
      }

      const previewStores = createProjectAuthPreviewStoreLifecycle({
        authStorageDirectory: directory,
        publicOrigin: "https://auth.example.test",
        secretStore,
        emailProvider: new LocalAuthEmailSink(),
        ...securityOptions(),
      });
      await previewStores.create(previewTenant, [
        { id: "demo-user", name: "Demo user", email: "demo@example.test" },
      ]);

      const previewDatabase = new Database(databasePath(directory, previewTenant, "preview"));
      try {
        expect(
          previewDatabase
            .query<{ email: string }, []>("SELECT email FROM user ORDER BY email")
            .all(),
        ).toEqual([{ email: "demo@example.test" }]);
        expect(
          previewDatabase
            .query<{ count: number }, []>("SELECT count(*) AS count FROM account")
            .get(),
        ).toEqual({
          count: 0,
        });
        expect(
          previewDatabase
            .query<{ count: number }, []>("SELECT count(*) AS count FROM session")
            .get(),
        ).toEqual({
          count: 0,
        });
      } finally {
        previewDatabase.close(false);
      }
      await previewStores.delete(previewTenant);
      expect(existsSync(databasePath(directory, previewTenant, "preview"))).toBe(false);
    } finally {
      production.close();
    }
  });

  test("runs Better Auth SQLite migrations idempotently and serves the adapter health route", async () => {
    const directory = await createFixture();
    const tenantIdentity = tenant("project-one");
    const options = {
      tenant: tenantIdentity,
      mode: { kind: "production" } as const,
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: new LocalAuthEmailSink(),
      ...securityOptions(),
    };
    const first = await openProjectAuthService(options);

    try {
      const response = await first.handleRequest(new Request(`${first.binding.issuer}/ok`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      first.close();
    }

    const second = await openProjectAuthService(options);
    try {
      const database = new Database(databasePath(directory, tenantIdentity, "production"));
      try {
        expect(
          database
            .query<{ name: string }, []>(`
              SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN ('user', 'session', 'account', 'verification')
              ORDER BY name
            `)
            .all(),
        ).toEqual([
          { name: "account" },
          { name: "session" },
          { name: "user" },
          { name: "verification" },
        ]);
      } finally {
        database.close(false);
      }
    } finally {
      second.close();
    }
  });

  test("supports email/password registration, hashed OTP verification, login, refresh rotation, and replay revocation", async () => {
    const directory = await createFixture();
    const emailProvider = new LocalAuthEmailSink();
    const tenantIdentity = tenant("project-email");
    const service = await openProjectAuthService({
      tenant: tenantIdentity,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      ...securityOptions(),
    });

    try {
      const signUp = await service.handleRequest(
        authRequest(service, "/sign-up/email", {
          email: "member@example.test",
          name: "Member",
          password: "correct-horse-battery-staple",
        }),
      );
      expect(signUp.status).toBe(200);
      expect(await signUp.json()).toMatchObject({ token: null });
      expect(emailProvider.messages).toHaveLength(1);
      expect(emailProvider.messages[0]).toMatchObject({
        purpose: "email-verification",
        to: "member@example.test",
      });

      const verificationOtp = otpFromMessage(emailProvider.messages[0].text);
      const database = new Database(databasePath(directory, tenantIdentity, "production"));
      try {
        const verification = database
          .query<{ value: string }, [string]>("SELECT value FROM verification WHERE identifier = ?")
          .get("email-verification:member@example.test");
        expect(verification?.value ?? "").not.toContain(verificationOtp);
      } finally {
        database.close(false);
      }

      const unverifiedLogin = await service.handleRequest(
        authRequest(service, "/sign-in/email", {
          email: "member@example.test",
          password: "correct-horse-battery-staple",
        }),
      );
      expect(unverifiedLogin.status).toBe(403);

      const verified = await service.handleRequest(
        authRequest(service, "/email-otp/verify-email", {
          email: "member@example.test",
          otp: verificationOtp,
        }),
      );
      expect(verified.status).toBe(200);

      const replay = await service.handleRequest(
        authRequest(service, "/email-otp/verify-email", {
          email: "member@example.test",
          otp: verificationOtp,
        }),
      );
      expect(replay.status).toBe(400);

      const login = await service.handleRequest(
        authRequest(service, "/sign-in/email", {
          email: "member@example.test",
          password: "correct-horse-battery-staple",
        }),
      );
      expect(login.status).toBe(200);
      const loginBody = (await login.json()) as { refreshToken: string };
      expect(loginBody.refreshToken.length).toBeGreaterThanOrEqual(32);

      const refresh = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken: loginBody.refreshToken }),
      );
      expect(refresh.status).toBe(200);
      const refreshBody = (await refresh.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      expect(refreshBody.accessToken).not.toBe(loginBody.refreshToken);
      expect(refreshBody.refreshToken).not.toBe(loginBody.refreshToken);

      const reuse = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken: loginBody.refreshToken }),
      );
      expect(reuse.status).toBe(401);

      const rotatedTokenAfterReuse = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken: refreshBody.refreshToken }),
      );
      expect(rotatedTokenAfterReuse.status).toBe(401);
    } finally {
      service.close();
    }
  });

  test("revokes the login refresh token on sign-out", async () => {
    const directory = await createFixture();
    const emailProvider = new LocalAuthEmailSink();
    const service = await openProjectAuthService({
      tenant: tenant("project-sign-out"),
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      ...securityOptions(),
    });

    try {
      const email = "sign-out@example.test";
      const password = "correct-horse-battery-staple";
      await service.handleRequest(
        authRequest(service, "/sign-up/email", { email, name: "Member", password }),
      );
      await service.handleRequest(
        authRequest(service, "/email-otp/verify-email", {
          email,
          otp: otpFromMessage(emailProvider.messages[0].text),
        }),
      );
      const login = await service.handleRequest(
        authRequest(service, "/sign-in/email", { email, password }),
      );
      expect(login.status).toBe(200);
      const { accessToken, refreshToken } = (await login.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      const verifiedAccessToken = await service.verifyAccessToken(accessToken);
      expect(
        service.isSessionActive(verifiedAccessToken.sessionId, verifiedAccessToken.userId),
      ).toBe(true);
      const sessionCookie = cookieFromSetCookie(login.headers.get("set-cookie"), "session_token");

      const signOut = await service.handleRequest(
        new Request(`${service.binding.issuer}/sign-out`, {
          method: "POST",
          headers: { cookie: sessionCookie, origin: "https://auth.example.test" },
        }),
      );
      expect(signOut.status).toBe(200);
      expect(
        service.isSessionActive(verifiedAccessToken.sessionId, verifiedAccessToken.userId),
      ).toBe(false);

      const refresh = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken }),
      );
      expect(refresh.status).toBe(401);
      expect(await refresh.json()).toEqual({ code: "AUTH_REFRESH_TOKEN_INVALID" });
    } finally {
      service.close();
    }
  });

  test("validates issuer, audience, expiry, JWKS kid, and signing-key rotation overlap", async () => {
    const directory = await createFixture();
    const tenantIdentity = tenant("project-jwt");
    const oldKeySet = await createSigningKeySet("signing-key-old1");
    const newKeySet = await createSigningKeySet("signing-key-new1");
    let currentTime = Date.UTC(2026, 7, 4, 12, 0, 0);
    const emailProvider = new LocalAuthEmailSink();
    const baseOptions = {
      tenant: tenantIdentity,
      mode: { kind: "production" } as const,
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      domainOwnershipVerifier,
      now: () => currentTime,
    };
    const oldService = await openProjectAuthService({
      ...baseOptions,
      signingKeyStore: signingKeyStoreFor(oldKeySet),
    });
    const tokens = await registerVerifiedUser(oldService, emailProvider, "jwt@example.test");
    const verified = await oldService.verifyAccessToken(tokens.accessToken);
    expect(verified.tenant).toEqual(tenantIdentity);
    expect(verified.userId.length).toBeGreaterThan(2);

    const wrongIssuer = await signTestAccessToken(
      oldKeySet,
      tenantIdentity,
      "https://attacker.example.test",
      oldService.binding.audience,
      currentTime,
    );
    const wrongAudience = await signTestAccessToken(
      oldKeySet,
      tenantIdentity,
      oldService.binding.issuer,
      "mekka:wrong-audience",
      currentTime,
    );
    await expect(oldService.verifyAccessToken(wrongIssuer)).rejects.toMatchObject({
      code: "AUTH_ACCESS_TOKEN_INVALID",
    });
    await expect(oldService.verifyAccessToken(wrongAudience)).rejects.toMatchObject({
      code: "AUTH_ACCESS_TOKEN_INVALID",
    });
    oldService.close();

    const rotatedService = await openProjectAuthService({
      ...baseOptions,
      signingKeyStore: signingKeyStoreFor({
        current: newKeySet.current,
        previous: [
          {
            kid: oldKeySet.current.kid,
            publicKeyJwk: oldKeySet.current.publicKeyJwk,
            expiresAt: currentTime + 12 * 60 * 1000,
          },
        ],
      }),
    });
    try {
      await expect(rotatedService.verifyAccessToken(tokens.accessToken)).resolves.toMatchObject({
        tenant: tenantIdentity,
      });
      const jwksResponse = await rotatedService.handleRequest(
        new Request(`${rotatedService.binding.issuer}/.well-known/jwks.json`),
      );
      const jwks = (await jwksResponse.json()) as { keys: JWK[] };
      expect(jwks.keys.map((key) => key.kid).sort()).toEqual(
        [oldKeySet.current.kid, newKeySet.current.kid].sort(),
      );
      expect(JSON.stringify(jwks)).not.toContain('"d"');

      currentTime += 13 * 60 * 1000;
      await expect(rotatedService.verifyAccessToken(tokens.accessToken)).rejects.toMatchObject({
        code: "AUTH_ACCESS_TOKEN_INVALID",
      });

      const expiredToken = await signTestAccessToken(
        newKeySet,
        tenantIdentity,
        rotatedService.binding.issuer,
        rotatedService.binding.audience,
        currentTime - 16 * 60 * 1000,
      );
      await expect(rotatedService.verifyAccessToken(expiredToken)).rejects.toMatchObject({
        code: "AUTH_ACCESS_TOKEN_INVALID",
      });
    } finally {
      rotatedService.close();
    }
  });

  test("completes Google and GitHub OAuth with state, PKCE, exact redirects, and no token passthrough", async () => {
    const directory = await createFixture();
    const tenantIdentity = tenant("project-oauth");
    const ownedOrigins: string[] = [];
    const { privateKey: googlePrivateKey, publicKey: googlePublicKey } = await generateKeyPair(
      "RS256",
      { extractable: true },
    );
    const googlePublicJwk = {
      ...(await exportJWK(googlePublicKey)),
      alg: "RS256",
      kid: "google-test-key",
      use: "sig",
    };
    const googleIdToken = await new SignJWT({
      azp: "google-client",
      email: "google@example.test",
      email_verified: true,
      name: "Google Member",
      picture: "https://images.example.test/google.png",
    })
      .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client")
      .setSubject("google-user-001")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(googlePrivateKey);
    const googleLinkAttemptIdToken = await new SignJWT({
      azp: "google-client",
      email: "blocked-link@example.test",
      email_verified: true,
      name: "Blocked Link",
    })
      .setProtectedHeader({ alg: "RS256", kid: "google-test-key" })
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client")
      .setSubject("google-user-link-attempt")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(googlePrivateKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      if (requestUrl === "https://oauth2.googleapis.com/token") {
        const body = String(init?.body ?? "");
        expect(body).toContain("code_verifier=");
        expect(body).toContain(
          `redirect_uri=${encodeURIComponent(`${service.binding.issuer}/callback/google`)}`,
        );
        return Response.json({
          access_token: "google-provider-access-token",
          expires_in: 3600,
          id_token: body.includes("code=link-code") ? googleLinkAttemptIdToken : googleIdToken,
          token_type: "Bearer",
        });
      }
      if (requestUrl === "https://www.googleapis.com/oauth2/v3/certs") {
        return Response.json({ keys: [googlePublicJwk] });
      }
      if (requestUrl === "https://github.com/login/oauth/access_token") {
        const body = String(init?.body ?? "");
        expect(body).toContain("code_verifier=");
        expect(body).toContain(
          `redirect_uri=${encodeURIComponent(`${service.binding.issuer}/callback/github`)}`,
        );
        return Response.json({
          access_token: "github-provider-access-token",
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      }
      if (requestUrl === "https://api.github.com/user") {
        return Response.json({
          id: "github-user-001",
          login: "github-member",
          name: "GitHub Member",
          email: null,
          avatar_url: "https://images.example.test/github.png",
        });
      }
      if (requestUrl === "https://api.github.com/user/emails") {
        return Response.json([
          {
            email: "github@example.test",
            primary: true,
            verified: true,
            visibility: "private",
          },
        ]);
      }
      throw new Error(`Unexpected OAuth fetch: ${requestUrl}`);
    }) as typeof fetch;

    const emailProvider = new LocalAuthEmailSink();
    const service = await openProjectAuthService({
      tenant: tenantIdentity,
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      signingKeyStore,
      domainOwnershipVerifier: {
        async isVerifiedOrigin({ origin }): Promise<boolean> {
          ownedOrigins.push(origin);
          return origin === "https://auth.example.test" || origin === "https://app.example.test";
        },
      },
      oauth: {
        providers: ["google", "github"],
        redirectAllowlist: [
          "https://app.example.test/auth/google",
          "https://app.example.test/auth/github",
          "https://app.example.test/auth/error",
        ],
      },
    });

    try {
      expect(new Set(ownedOrigins)).toEqual(
        new Set(["https://auth.example.test", "https://app.example.test"]),
      );
      const invalidRedirect = await service.handleRequest(
        authRequest(service, "/sign-in/social", {
          provider: "google",
          callbackURL: "https://app.example.test/auth/google/",
        }),
      );
      expect(invalidRedirect.status).toBe(400);
      expect(await invalidRedirect.json()).toEqual({ code: "AUTH_OAUTH_INVALID" });

      await registerVerifiedUser(service, emailProvider, "blocked-link@example.test");
      const linkStarted = await service.handleRequest(
        authRequest(service, "/sign-in/social", {
          provider: "google",
          callbackURL: "https://app.example.test/auth/google",
          errorCallbackURL: "https://app.example.test/auth/error",
        }),
      );
      const linkAuthorizationUrl = new URL(((await linkStarted.json()) as { url: string }).url);
      const linkState = linkAuthorizationUrl.searchParams.get("state") ?? "";
      const linkCallback = await service.handleRequest(
        new Request(
          `${service.binding.issuer}/callback/google?state=${encodeURIComponent(linkState)}&code=link-code`,
          {
            headers: {
              cookie: cookieFromSetCookie(linkStarted.headers.get("set-cookie"), "state"),
              origin: "https://auth.example.test",
            },
          },
        ),
      );
      expect(linkCallback.status).toBe(302);
      expect(linkCallback.headers.get("location")).toContain("https://app.example.test/auth/error");
      expect(linkCallback.headers.get("set-cookie") ?? "").not.toContain("session_token");

      for (const provider of ["google", "github"] as const) {
        const callbackURL = `https://app.example.test/auth/${provider}`;
        const started = await service.handleRequest(
          authRequest(service, "/sign-in/social", { provider, callbackURL }),
        );
        expect(started.status).toBe(200);
        const startedBody = (await started.json()) as { url: string };
        const authorizationUrl = new URL(startedBody.url);
        expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizationUrl.searchParams.get("code_challenge")?.length).toBeGreaterThan(32);
        const state = authorizationUrl.searchParams.get("state");
        expect(state).toBeTruthy();
        const stateCookie = cookieFromSetCookie(started.headers.get("set-cookie"), "state");

        const callback = await service.handleRequest(
          new Request(
            `${service.binding.issuer}/callback/${provider}?state=${encodeURIComponent(state ?? "")}&code=${provider}-code`,
            { headers: { cookie: stateCookie, origin: "https://auth.example.test" } },
          ),
        );
        expect(callback.status).toBe(302);
        expect(callback.headers.get("location")).toBe(callbackURL);
        expect(callback.headers.get("location")).not.toContain("provider-access-token");
        const sessionCookie = cookieFromSetCookie(
          callback.headers.get("set-cookie"),
          "session_token",
        );
        const tokenResponse = await service.handleRequest(
          new Request(`${service.binding.issuer}/token`, {
            method: "POST",
            headers: { cookie: sessionCookie, origin: "https://auth.example.test" },
          }),
        );
        expect(tokenResponse.status).toBe(200);
        const tokens = (await tokenResponse.json()) as {
          accessToken: string;
          refreshToken: string;
          tokenType: string;
        };
        expect(tokens.tokenType).toBe("Bearer");
        expect(JSON.stringify(tokens)).not.toContain(`${provider}-provider-access-token`);
        await expect(service.verifyAccessToken(tokens.accessToken)).resolves.toMatchObject({
          tenant: tenantIdentity,
        });

        const replay = await service.handleRequest(
          new Request(
            `${service.binding.issuer}/callback/${provider}?state=${encodeURIComponent(state ?? "")}&code=replay`,
            { headers: { cookie: stateCookie, origin: "https://auth.example.test" } },
          ),
        );
        expect(replay.status).toBe(302);
        expect(replay.headers.get("location")).toContain("error");
      }

      const database = new Database(databasePath(directory, tenantIdentity, "production"));
      try {
        const storedTokens = database
          .query<{ providerId: string; accessToken: string }, []>(`
            SELECT providerId, accessToken FROM account
            WHERE providerId IN ('google', 'github') ORDER BY providerId
          `)
          .all();
        expect(storedTokens).toHaveLength(2);
        expect(JSON.stringify(storedTokens)).not.toContain("provider-access-token");
      } finally {
        database.close(false);
      }
    } finally {
      service.close();
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects unverified OAuth custom domains before opening the auth store", async () => {
    const directory = await createFixture();
    await expect(
      openProjectAuthService({
        tenant: tenant("project-unverified-domain"),
        mode: { kind: "production" },
        authStorageDirectory: directory,
        publicOrigin: "https://auth.example.test",
        secretStore,
        emailProvider: new LocalAuthEmailSink(),
        signingKeyStore,
        domainOwnershipVerifier: {
          async isVerifiedOrigin({ origin }): Promise<boolean> {
            return origin === "https://auth.example.test";
          },
        },
        oauth: {
          providers: ["google"],
          redirectAllowlist: ["https://unverified.example.test/callback"],
        },
      }),
    ).rejects.toEqual(
      new AuthServiceError(
        "AUTH_CONFIG_INVALID",
        "Auth origin ownership has not been verified for this tenant.",
      ),
    );
  });

  test("uses indistinguishable password-reset responses and revokes active sessions after a reset", async () => {
    const directory = await createFixture();
    const emailProvider = new LocalAuthEmailSink();
    const service = await openProjectAuthService({
      tenant: tenant("project-reset"),
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider,
      ...securityOptions(),
    });

    try {
      await service.handleRequest(
        authRequest(service, "/sign-up/email", {
          email: "reset@example.test",
          name: "Reset member",
          password: "correct-horse-battery-staple",
        }),
      );
      await service.handleRequest(
        authRequest(service, "/email-otp/verify-email", {
          email: "reset@example.test",
          otp: otpFromMessage(emailProvider.messages[0].text),
        }),
      );
      const login = await service.handleRequest(
        authRequest(service, "/sign-in/email", {
          email: "reset@example.test",
          password: "correct-horse-battery-staple",
        }),
      );
      const { refreshToken } = (await login.json()) as { refreshToken: string };

      const knownReset = await service.handleRequest(
        authRequest(service, "/email-otp/request-password-reset", {
          email: "reset@example.test",
        }),
      );
      const unknownReset = await service.handleRequest(
        authRequest(service, "/email-otp/request-password-reset", {
          email: "unknown@example.test",
        }),
      );
      expect(await knownReset.json()).toEqual(await unknownReset.json());
      expect(emailProvider.messages).toHaveLength(2);

      const reset = await service.handleRequest(
        authRequest(service, "/email-otp/reset-password", {
          email: "reset@example.test",
          otp: otpFromMessage(emailProvider.messages[1].text),
          password: "new-correct-horse-battery-staple",
        }),
      );
      expect(reset.status).toBe(200);

      const revokedRefresh = await service.handleRequest(
        authRequest(service, "/refresh", { refreshToken }),
      );
      expect(revokedRefresh.status).toBe(401);

      const newLogin = await service.handleRequest(
        authRequest(service, "/sign-in/email", {
          email: "reset@example.test",
          password: "new-correct-horse-battery-staple",
        }),
      );
      expect(newLogin.status).toBe(200);
    } finally {
      service.close();
    }
  });

  test("rate limits OTP delivery and keeps mail sinks isolated by project", async () => {
    const directory = await createFixture();
    const firstEmailProvider = new LocalAuthEmailSink();
    const first = await openProjectAuthService({
      tenant: tenant("project-mail-one"),
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: firstEmailProvider,
      ...securityOptions(),
    });
    const secondEmailProvider = new LocalAuthEmailSink();
    const second = await openProjectAuthService({
      tenant: tenant("project-mail-two"),
      mode: { kind: "production" },
      authStorageDirectory: directory,
      publicOrigin: "https://auth.example.test",
      secretStore,
      emailProvider: secondEmailProvider,
      ...securityOptions(),
    });

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await first.handleRequest(
          authRequest(first, "/email-otp/send-verification-otp", {
            email: "absent@example.test",
            type: "email-verification",
          }),
        );
        expect(response.status).toBe(200);
      }
      const blocked = await first.handleRequest(
        authRequest(first, "/email-otp/send-verification-otp", {
          email: "absent@example.test",
          type: "email-verification",
        }),
      );
      expect(blocked.status).toBe(429);
      expect(firstEmailProvider.messages).toHaveLength(0);
      expect(secondEmailProvider.messages).toHaveLength(0);
    } finally {
      first.close();
      second.close();
    }
  });
});
