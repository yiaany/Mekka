import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createMcpHttpResponse } from "@mekka/mcp";
import { policyFormatVersion } from "@mekka/policy-engine";
import {
  createTenantCacheKey,
  createCorrelationId,
  createTenantContext,
  parseTenantIdentityFromHeaders,
  ProtocolError,
} from "@mekka/protocol";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import { createSqliteMetaApp } from "./app";
import { openLocalAuthRuntime } from "./auth";

const port = readPort(process.env.SQLITE_META_PORT ?? "3001");
const host = process.env.SQLITE_META_HOST ?? "127.0.0.1";
const configuredDataDirectory = process.env.SQLITE_META_DATA_DIRECTORY ?? ".local/sqlite-meta";
const dataDirectory = resolve(configuredDataDirectory);
const isLocalDevelopment = process.env.MEKKA_LOCAL_DEV === "1";

if (!isLocalDevelopment && process.env.MEKKA_SQLITE_META_SERVICE !== "1") {
  throw new Error("sqlite-meta requires MEKKA_LOCAL_DEV=1 or MEKKA_SQLITE_META_SERVICE=1.");
}
if (!isLocalDevelopment && !isAbsolute(configuredDataDirectory)) {
  throw new Error("SQLITE_META_DATA_DIRECTORY must be absolute outside local development.");
}
if (!isLocalDevelopment && host !== "127.0.0.1" && host !== "::1") {
  throw new Error("SQLITE_META_HOST must remain loopback-only in production.");
}

await mkdir(dataDirectory, { recursive: true });

const adapters = new Map<string, StorageAdapter>();
const authRuntime = await openLocalAuthRuntime(dataDirectory);
const mcpTokens = new Map<
  string,
  Readonly<{
    verified: Awaited<ReturnType<typeof authRuntime.verifyAccessToken>>;
    expiresAt: number;
  }>
>();
const mcpTokenByActor = new Map<string, string>();
const maxActiveMcpTokens = 10_000;
const publicStudioOrigin =
  process.env.MEKKA_PUBLIC_URL ?? process.env.AUTH_PUBLIC_ORIGIN ?? "http://127.0.0.1:8082";
const publicMcpUrl = new URL("/mcp", publicStudioOrigin).href;
const mcpDependencies = {
  resolveProject(context: ReturnType<typeof createTenantContext>) {
    const key = createTenantCacheKey(context.tenant, "sqlite-meta-local");
    let storage = adapters.get(key);
    if (storage === undefined) {
      const fileName = `${createHash("sha256").update(key).digest("hex")}.sqlite`;
      storage = openStorageAdapter({
        databaseDirectory: dataDirectory,
        databasePath: join(dataDirectory, fileName),
      });
      adapters.set(key, storage);
    }
    return {
      tenant: context.tenant,
      storage,
      policies: Object.freeze({ formatVersion: policyFormatVersion, tables: Object.freeze([]) }),
    };
  },
  listLogs: () => Object.freeze([]),
  tokenVerifier: {
    async verifyAccessToken(token: string) {
      pruneMcpTokens();
      const grant = mcpTokens.get(token);
      if (grant === undefined || grant.expiresAt <= Date.now()) {
        mcpTokens.delete(token);
        throw new Error("Agent Access token is invalid or expired.");
      }
      return grant.verified;
    },
  },
  capabilityStore: {
    async listCapabilities({
      tenant,
      actorId,
    }: {
      tenant: typeof authRuntime.binding.tenant;
      actorId: string;
    }) {
      return Object.freeze([
        Object.freeze({
          id: `mcp-read-${actorId}`,
          tenant,
          actions: Object.freeze(["mcp:read" as const]),
          expiresAt: Date.now() + 5 * 60_000,
        }),
      ]);
    },
  },
  protectedResource: {
    resourceUrl: publicMcpUrl,
    authorizationServerUrl: authRuntime.binding.issuer,
  },
};
const app = createSqliteMetaApp({
  authenticate(request) {
    const tenant = parseTenantIdentityFromHeaders(request.headers);
    if (
      tenant.organizationId !== (process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? "org-local") ||
      tenant.projectId !== "local" ||
      tenant.environmentId !== (process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? "env-local") ||
      tenant.branchId !== (process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? "branch-main") ||
      tenant.generation !== Number(process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? "1")
    ) {
      throw new ProtocolError("forbidden");
    }
    return createTenantContext({
      tenant,
      actor: { kind: "service", id: "studio-local" },
      capabilities: [
        {
          id: "studio-local-admin",
          tenant,
          actions: ["schema:read", "schema:manage", "data:read", "data:write", "sql:execute"],
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      ],
      correlationId: createCorrelationId(),
    });
  },
  resolveProject(context) {
    const key = createTenantCacheKey(context.tenant, "sqlite-meta-local");
    let storage = adapters.get(key);
    if (storage === undefined) {
      const fileName = `${createHash("sha256").update(key).digest("hex")}.sqlite`;
      storage = openStorageAdapter({
        databaseDirectory: dataDirectory,
        databasePath: join(dataDirectory, fileName),
      });
      adapters.set(key, storage);
    }
    return { tenant: context.tenant, storage };
  },
  recordAudit() {},
  checkpointDirectory: dataDirectory,
})
  .all("/auth/*", ({ request }) => authRuntime.handlePublicRequest(request))
  .all("/auth-admin/:ref/*", ({ request, params }) =>
    authRuntime.handleAdminRequest(request, params.ref),
  )
  .get("/auth-local/verification-code", ({ request }) => {
    if (!isLocalDevelopment) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const email = new URL(request.url).searchParams.get("email")?.trim() ?? "";
    const code = email.length > 0 ? authRuntime.verificationCode(email) : null;
    return code === null
      ? Response.json({ error: "not_found" }, { status: 404 })
      : Response.json({ code }, { headers: { "cache-control": "no-store" } });
  })
  .post("/auth-local/agent-token", async ({ request }) => {
    const authorization = request.headers.get("authorization");
    const accessToken = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
    if (accessToken === undefined) {
      return Response.json({ error: "auth" }, { status: 401 });
    }
    try {
      const verified = await authRuntime.verifyAccessToken(accessToken);
      pruneMcpTokens();
      const previousToken = mcpTokenByActor.get(verified.userId);
      if (previousToken !== undefined) mcpTokens.delete(previousToken);
      if (mcpTokens.size >= maxActiveMcpTokens) {
        return Response.json({ error: "quota" }, { status: 429 });
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = Math.min(verified.expiresAt * 1_000, Date.now() + 5 * 60_000);
      mcpTokens.set(token, Object.freeze({ verified, expiresAt }));
      mcpTokenByActor.set(verified.userId, token);
      return Response.json({ token, expiresAt }, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "auth" }, { status: 401 });
    }
  })
  .all("/mcp", ({ request }) =>
    createMcpHttpResponse(new Request(publicMcpUrl, request), mcpDependencies),
  )
  .all("/.well-known/oauth-protected-resource/mcp", ({ request }) =>
    createMcpHttpResponse(
      new Request(
        new URL("/.well-known/oauth-protected-resource/mcp", publicStudioOrigin).href,
        request,
      ),
      mcpDependencies,
    ),
  );

app.listen({ hostname: host, port });
console.log(`sqlite-meta backend listening on http://${host}:${port}`);

function close(): void {
  app.stop();
  authRuntime.close();
  for (const adapter of adapters.values()) adapter.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);

function pruneMcpTokens(): void {
  const now = Date.now();
  for (const [token, grant] of mcpTokens) {
    if (grant.expiresAt > now) continue;
    mcpTokens.delete(token);
    if (mcpTokenByActor.get(grant.verified.userId) === token) {
      mcpTokenByActor.delete(grant.verified.userId);
    }
  }
}

function readPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SQLITE_META_PORT must be a valid TCP port.");
  }
  return parsed;
}
