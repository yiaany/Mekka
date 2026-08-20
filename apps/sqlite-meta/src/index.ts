import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { policyFormatVersion } from "@mekka/policy-engine";
import { openSqliteEngine, type Engine } from "@mekka/engine-core";
import {
  createCorrelationId,
  createTenantCacheKey,
  createTenantContext,
  ProtocolError,
  parseTenantIdentity,
  parseTenantIdentityFromHeaders,
} from "@mekka/protocol";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core/sqlite";
import { createAsyncSchemaManifestCache } from "@mekka/schema-manifest";
import { openAgentTokenStore } from "./agent-token-store";
import { createSqliteMetaApp } from "./app";
import type { LocalAuthRuntime } from "./auth";
import { openEngineController, readEngineConfiguration } from "./engine";
import {
  isInternalProxyRequest as matchesInternalProxy,
  readInternalProxyToken,
} from "./internal-proxy";
import type { LocalMcpRuntime, McpApprovalRecord } from "./mcp-runtime";
import { openPreviewDependencies } from "./preview-configuration";

const port = readPort(process.env.SQLITE_META_PORT ?? "3001");
export const agentAccessTtlMs = 60 * 60_000;
const host = process.env.SQLITE_META_HOST ?? "127.0.0.1";
const configuredDataDirectory = process.env.SQLITE_META_DATA_DIRECTORY ?? ".local/sqlite-meta";
const dataDirectory = resolve(configuredDataDirectory);
const isLocalDevelopment = process.env.MEKKA_LOCAL_DEV === "1";
const internalProxyToken = readInternalProxyToken(
  process.env.MEKKA_INTERNAL_PROXY_TOKEN,
  !isLocalDevelopment,
);

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
await mkdir(join(dataDirectory, "auth"), { recursive: true });

const adapters = new Map<string, StorageAdapter>();
const engines = new Map<string, Engine>();
const agentTokens = openAgentTokenStore(join(dataDirectory, "auth", "agent-access.sqlite"));
const engineController = openEngineController(readEngineConfiguration(process.env));
const previewDependencies = openPreviewDependencies(process.env, isLocalDevelopment);
const productionTenant = parseTenantIdentity({
  organizationId: process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? "org-local",
  projectId: "local",
  environmentId: process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? "env-local",
  branchId: process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? "branch-main",
  generation: Number(process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? "1"),
});
const authSessionSecret =
  process.env.MEKKA_AUTH_SESSION_SECRET?.trim() ||
  "local-only-auth-session-secret-that-is-long-enough";
let authRuntime: LocalAuthRuntime | undefined;
let authRuntimePromise: Promise<LocalAuthRuntime> | undefined;
let mcpRuntime: LocalMcpRuntime | undefined;
let mcpRuntimePromise: Promise<LocalMcpRuntime> | undefined;
let previewCleanupTimer: ReturnType<typeof setInterval> | undefined;
const publicStudioOrigin =
  process.env.MEKKA_PUBLIC_URL ?? process.env.AUTH_PUBLIC_ORIGIN ?? "http://127.0.0.1:8082";
const publicMcpUrl = new URL("/mcp", publicStudioOrigin).href;

async function getAuthRuntime(): Promise<LocalAuthRuntime> {
  if (authRuntime !== undefined) return authRuntime;
  authRuntimePromise ??= import("./auth").then(async ({ openLocalAuthRuntime }) => {
    const runtime = await openLocalAuthRuntime(dataDirectory);
    authRuntime = runtime;
    return runtime;
  });
  return authRuntimePromise;
}

function hashAgentAccessToken(token: string): string {
  return createHmac("sha256", authSessionSecret).update(token).digest("hex");
}
async function getMcpRuntime(): Promise<LocalMcpRuntime> {
  if (mcpRuntime !== undefined) return mcpRuntime;
  mcpRuntimePromise ??= import("./mcp-runtime").then(async ({ openLocalMcpRuntime }) => {
    const runtime = await openLocalMcpRuntime({
      dataDirectory,
      productionTenant,
      resolveProductionStorage,
      beforePreviewDelete: closeTenantStorage,
    });
    mcpRuntime = runtime;
    previewCleanupTimer = setInterval(() => {
      agentTokens.cleanupExpired();
      void runtime.cleanupExpired().catch(() => {});
    }, 60_000);
    previewCleanupTimer.unref();
    return runtime;
  });
  return mcpRuntimePromise;
}

async function getMcpDependencies() {
  const mcp = await import("@mekka/mcp");
  const runtime = engineController.engine === null ? await getMcpRuntime() : undefined;
  return {
    createMcpHttpResponse: mcp.createMcpHttpResponse,
    dependencies: {
      resolveProject(context: ReturnType<typeof createTenantContext>) {
        return {
          tenant: context.tenant,
          storage:
            engineController.engine === null
              ? resolveStorage(context.tenant)
              : resolveDataProject(context.tenant).engine,
          policies: Object.freeze({
            formatVersion: policyFormatVersion,
            tables: Object.freeze([]),
          }),
        };
      },
      listLogs: () => Object.freeze([]),
      ...(runtime === undefined ? {} : { mutations: runtime.mutations }),
      tokenVerifier: {
        async verifyAccessToken(token: string) {
          const auth = await getAuthRuntime();
          const grant = agentTokens.verify(hashAgentAccessToken(token));
          if (grant === null || !auth.isSessionActive(grant.sessionId, grant.userId)) {
            if (grant !== null) agentTokens.revokeSession(grant.sessionId);
            throw new Error("Agent Access token is invalid or expired.");
          }
          return grant;
        },
      },
      capabilityStore: {
        async listCapabilities({
          tenant,
          actorId,
          tokenId,
        }: {
          tenant: typeof productionTenant;
          actorId: string;
          tokenId: string;
        }) {
          const mode = agentTokens.modeFor(tokenId, tenant, actorId);
          if (mode === null) throw new Error("Agent Access grant is unavailable.");
          const allowRowData = agentTokens.rowDataAllowed(tokenId, tenant, actorId);
          const actions =
            mode === "write"
              ? [
                  mcp.mcpCapabilityAction,
                  mcp.mcpPreviewProposeAction,
                  mcp.mcpPreviewApplyAction,
                  mcp.mcpPreviewValidateAction,
                  mcp.mcpPromotionRequestAction,
                ]
              : [mcp.mcpCapabilityAction, ...(allowRowData ? [mcp.mcpDataReadAction] : [])];
          return Object.freeze([
            Object.freeze({
              id: `mcp-${mode}-${tokenId}`,
              tenant,
              actions: Object.freeze(actions),
              expiresAt: Date.now() + agentAccessTtlMs,
            }),
          ]);
        },
      },
      protectedResource: {
        resourceUrl: publicMcpUrl,
        authorizationServerUrl: (await getAuthRuntime()).binding.issuer,
      },
    },
  };
}
const app = createSqliteMetaApp({
  authenticate(request) {
    requireInternalProxy(request);
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
          actions: [
            "schema:read",
            "schema:manage",
            "data:read",
            "data:write",
            "sql:execute",
            "preview:manage",
          ],
          expiresAt: Number.MAX_SAFE_INTEGER,
        },
      ],
      correlationId: createCorrelationId(),
    });
  },
  resolveProject(context) {
    return resolveDataProject(context.tenant);
  },
  recordAudit() {},
  engine: engineController,
  previews: previewDependencies,
  checkpointDirectory: dataDirectory,
})
  .all("/auth/*", async ({ request }) => (await getAuthRuntime()).handlePublicRequest(request))
  .all("/auth-admin/:ref/*", async ({ request, params }) =>
    isInternalProxyRequest(request)
      ? (await getAuthRuntime()).handleAdminRequest(request, params.ref)
      : Response.json({ error: { code: "auth" } }, { status: 401 }),
  )
  .get("/auth-local/verification-code", async ({ request }) => {
    if (!isLocalDevelopment) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const email = new URL(request.url).searchParams.get("email")?.trim() ?? "";
    const code = email.length > 0 ? (await getAuthRuntime()).verificationCode(email) : null;
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
      const auth = await getAuthRuntime();
      const verified = await auth.verifyAccessToken(accessToken);
      const agentRequest = await readAgentRequest(request);
      const { mode, allowRowData } = agentRequest;
      const rowDataEnabled = mode === "read" && allowRowData;
      if (mode === "write") requireInternalProxy(request);
      // Agent grants are independently revocable and are checked against the
      // source application session on every MCP request. They do not need to
      // inherit the shorter application JWT expiry.
      const expiresAt = Date.now() + agentAccessTtlMs;
      if (expiresAt <= Date.now() || !auth.isSessionActive(verified.sessionId, verified.userId)) {
        return Response.json({ error: "auth" }, { status: 401 });
      }
      let grantIdentity = Object.freeze({ ...verified, tokenId: randomUUID() });
      let previewCreated = false;
      if (mode === "write") {
        if (engineController.engine !== null) {
          return Response.json(
            {
              error: "unsupported",
              message: "Write-mode MCP previews are unavailable in this self-hosted profile.",
            },
            { status: 501, headers: { "cache-control": "no-store" } },
          );
        }
        const [runtime, { mcpPreviewCreateAction }] = await Promise.all([
          getMcpRuntime(),
          import("@mekka/mcp"),
        ]);
        const blockingApproval = runtime.approvals.findBlocking(verified.userId);
        if (blockingApproval !== null) return writeApprovalConflict(blockingApproval);
        if (expiresAt - Date.now() < 60_000) {
          return Response.json({ error: "auth" }, { status: 401 });
        }
        const previewTenant = parseTenantIdentity({
          ...productionTenant,
          branchId: `agent-${randomBytes(8).toString("hex")}`,
          generation: 1,
        });
        const previewContext = createTenantContext({
          tenant: productionTenant,
          actor: { kind: "agent", id: verified.userId },
          capabilities: [
            {
              id: `agent-preview-create-${grantIdentity.tokenId}`,
              tenant: productionTenant,
              actions: [mcpPreviewCreateAction],
              expiresAt,
            },
          ],
          correlationId: createCorrelationId(),
        });
        await runtime.mutations.createPreview(previewContext, {
          tenant: previewTenant,
          ttlSeconds: Math.max(60, Math.floor((expiresAt - Date.now()) / 1_000)),
          idempotencyKey: `agent-preview-${grantIdentity.tokenId}`,
        });
        grantIdentity = Object.freeze({ ...grantIdentity, tenant: previewTenant });
        previewCreated = true;
        const racedApproval = runtime.approvals.findBlocking(verified.userId);
        if (racedApproval !== null) {
          await runtime.branches.deleteBranch(
            grantIdentity.tenant,
            verified.userId,
            createCorrelationId(),
          );
          return writeApprovalConflict(racedApproval);
        }
      }
      const token = randomBytes(32).toString("base64url");
      if (
        !agentTokens.issue(
          hashAgentAccessToken(token),
          grantIdentity,
          expiresAt,
          mode,
          rowDataEnabled,
        )
      ) {
        if (previewCreated) {
          await (await getMcpRuntime()).branches.deleteBranch(
            grantIdentity.tenant,
            verified.userId,
            createCorrelationId(),
          );
        }
        return Response.json({ error: "quota" }, { status: 429 });
      }
      return Response.json(
        { token, expiresAt, mode, rowDataEnabled, tenant: grantIdentity.tenant },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "auth" }, { status: 401 });
    }
  })
  .get("/mcp-admin/approvals", async ({ request }) => {
    try {
      requireInternalProxy(request);
      const actorId = await requireActiveApplicationUser(request);
      const runtime = await getMcpRuntime();
      return Response.json(
        { approvals: runtime.approvals.list(actorId) },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "auth" }, { status: 401 });
    }
  })
  .patch("/mcp-admin/approvals/:approvalId", async ({ request, params }) => {
    let actorId: string;
    try {
      requireInternalProxy(request);
      actorId = await requireActiveApplicationUser(request);
    } catch {
      return Response.json({ error: "auth" }, { status: 401 });
    }
    const body: unknown = await request.json().catch(() => null);
    const state = readApprovalState(body);
    if (state === null) return Response.json({ error: "validation" }, { status: 400 });
    try {
      const runtime = await getMcpRuntime();
      return Response.json(runtime.approvals.decide(params.approvalId, actorId, state), {
        headers: { "cache-control": "no-store" },
      });
    } catch {
      return Response.json({ error: "conflict" }, { status: 409 });
    }
  })
  .all("/mcp", async ({ request }) => {
    const { createMcpHttpResponse, dependencies } = await getMcpDependencies();
    return createMcpHttpResponse(new Request(publicMcpUrl, request), dependencies);
  })
  .all("/.well-known/oauth-protected-resource/mcp", async ({ request }) => {
    const { createMcpHttpResponse, dependencies } = await getMcpDependencies();
    return createMcpHttpResponse(
      new Request(
        new URL("/.well-known/oauth-protected-resource/mcp", publicStudioOrigin).href,
        request,
      ),
      dependencies,
    );
  });

app.listen({ hostname: host, port });
console.log(`sqlite-meta backend listening on http://${host}:${port}`);

function close(): void {
  if (previewCleanupTimer !== undefined) clearInterval(previewCleanupTimer);
  app.stop();
  authRuntime?.close();
  agentTokens.close();
  mcpRuntime?.close();
  engineController.close();
  for (const engine of engines.values()) void engine.close();
  for (const adapter of adapters.values()) adapter.close();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);

function readPort(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("SQLITE_META_PORT must be a valid TCP port.");
  }
  return parsed;
}

function requireInternalProxy(request: Request): void {
  if (!isInternalProxyRequest(request)) throw new ProtocolError("auth");
}

function isInternalProxyRequest(request: Request): boolean {
  return matchesInternalProxy(request, internalProxyToken, isLocalDevelopment);
}

async function requireActiveApplicationUser(request: Request): Promise<string> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
  if (token === undefined) throw new ProtocolError("auth");
  const auth = await getAuthRuntime();
  const verified = await auth.verifyAccessToken(token);
  if (!auth.isSessionActive(verified.sessionId, verified.userId)) {
    throw new ProtocolError("auth");
  }
  return verified.userId;
}

function writeApprovalConflict(approval: McpApprovalRecord | null) {
  if (approval === null) throw new Error("Blocking approval is required.");
  return Response.json(
    {
      error: "approval_conflict",
      message:
        "Resolve or consume the existing MCP approval before issuing another write token. Read-only Agent Access remains available.",
      approval: {
        approvalId: approval.approvalId,
        state: approval.state,
        proposalId: approval.proposalId,
        branchId: approval.tenant.branchId,
      },
    },
    { status: 409, headers: { "cache-control": "no-store" } },
  );
}

function resolveProductionStorage(): StorageAdapter {
  if (engineController.engine !== null) {
    throw new ProtocolError("unsupported");
  }
  return openTenantStorage(productionTenant, undefined);
}

function resolveDataProject(tenant: typeof productionTenant) {
  if (engineController.engine !== null) {
    if (!sameTenant(tenant, productionTenant)) throw new ProtocolError("forbidden");
    return Object.freeze({
      tenant,
      engine: engineController.engine,
      schemaCache: createAsyncSchemaManifestCache(engineController.engine),
    });
  }
  const localStorage = resolveStorage(tenant);
  const engine = openTenantEngine(tenant, resolveTenantDatabasePath(tenant));
  return Object.freeze({
    tenant,
    engine,
    localStorage,
    schemaCache: createAsyncSchemaManifestCache(engine),
  });
}

function resolveStorage(tenant: typeof productionTenant): StorageAdapter {
  if (sameTenant(tenant, productionTenant)) return resolveProductionStorage();
  const branch = mcpRuntime?.branches
    .listBranches(productionTenant)
    .find((candidate) => sameTenant(candidate.tenant, tenant));
  if (!branch) throw new ProtocolError("forbidden");
  return openTenantStorage(tenant, branch.databasePath);
}

function openTenantStorage(
  tenant: typeof productionTenant,
  databasePath: string | undefined,
): StorageAdapter {
  const key = createTenantCacheKey(tenant, "sqlite-meta-local");
  let storage = adapters.get(key);
  if (storage === undefined) {
    const fileName = `${createHash("sha256").update(key).digest("hex")}.sqlite`;
    storage = openStorageAdapter({
      databaseDirectory: dataDirectory,
      databasePath: databasePath ?? join(dataDirectory, fileName),
    });
    adapters.set(key, storage);
  }
  return storage;
}

function resolveTenantDatabasePath(tenant: typeof productionTenant): string {
  const key = createTenantCacheKey(tenant, "sqlite-meta-local");
  const branch = mcpRuntime?.branches
    .listBranches(productionTenant)
    .find((candidate) => sameTenant(candidate.tenant, tenant));
  return (
    branch?.databasePath ??
    join(dataDirectory, `${createHash("sha256").update(key).digest("hex")}.sqlite`)
  );
}

function openTenantEngine(tenant: typeof productionTenant, databasePath: string): Engine {
  const key = createTenantCacheKey(tenant, "sqlite-meta-local");
  let engine = engines.get(key);
  if (engine === undefined) {
    engine = openSqliteEngine({ databaseDirectory: dataDirectory, databasePath });
    engines.set(key, engine);
  }
  return engine;
}

function closeTenantStorage(tenant: typeof productionTenant): void {
  const key = createTenantCacheKey(tenant, "sqlite-meta-local");
  const storage = adapters.get(key);
  if (!storage) return;
  storage.close();
  adapters.delete(key);
  const engine = engines.get(key);
  if (engine !== undefined) {
    void engine.close();
    engines.delete(key);
  }
}

function sameTenant(left: typeof productionTenant, right: typeof productionTenant): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.branchId === right.branchId &&
    left.generation === right.generation
  );
}

async function readAgentRequest(
  request: Request,
): Promise<Readonly<{ mode: "read" | "write"; allowRowData: boolean }>> {
  const text = await request.text();
  if (text.length === 0) return Object.freeze({ mode: "read", allowRowData: false });
  if (text.length > 1_024) throw new Error("Agent Access request is too large.");
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ mode: "read", allowRowData: false });
  }
  const record = value as Record<string, unknown>;
  return Object.freeze({
    mode: record.mode === "write" ? "write" : "read",
    allowRowData: record.allowRowData === true,
  });
}

function readApprovalState(value: unknown): "approved" | "rejected" | null {
  if (typeof value !== "object" || value === null || !("state" in value)) return null;
  return value.state === "approved" || value.state === "rejected" ? value.state : null;
}
