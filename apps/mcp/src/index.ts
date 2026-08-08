import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { VerifiedAuthAccessToken } from "@mekka/auth-core";
import type { BranchService } from "@mekka/branch-core";
import { createMigrationArtifact, type MigrationArtifact } from "@mekka/migration-engine";
import { type PolicyDocument, policyFormatVersion } from "@mekka/policy-engine";
import {
  type Capability,
  createCorrelationId,
  createTenantContext,
  hasCapability,
  ProtocolError,
  parseTenantIdentity,
  type TenantContext,
  type TenantIdentity,
} from "@mekka/protocol";
import { parseQuery } from "@mekka/query-ast";
import { buildSchemaManifest, type SchemaManifest } from "@mekka/schema-manifest";
import { compileSelect } from "@mekka/sqlite-compiler";
import type { StorageAdapter, StorageValue } from "@mekka/storage-core";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export const mcpCapabilityAction = "mcp:read";
export const mcpPreviewCreateAction = "mcp:preview:create";
export const mcpPreviewProposeAction = "mcp:preview:propose";
export const mcpPreviewApplyAction = "mcp:preview:apply";
export const mcpPreviewValidateAction = "mcp:preview:validate";
export const mcpPromotionRequestAction = "mcp:promotion:request";
export const mcpPromotionExecuteAction = "mcp:promotion:execute";
export const mcpProtocolVersion = "2025-11-25";

export type McpProject = Readonly<{
  tenant: TenantIdentity;
  storage: StorageAdapter;
  policies: PolicyDocument;
}>;

export type McpLogEntry = Readonly<{
  occurredAt: number;
  level: "debug" | "info" | "warn" | "error";
  event: string;
  correlationId: string;
  message: string;
  attributes?: Readonly<Record<string, unknown>>;
}>;

export type McpDependencies = Readonly<{
  resolveProject(context: TenantContext): Promise<McpProject> | McpProject;
  listLogs(context: TenantContext): Promise<readonly McpLogEntry[]> | readonly McpLogEntry[];
  mutations?: McpMutationWorkflow;
  now?: () => number;
}>;

type MutationState = "proposed" | "applied" | "validated" | "promotion_pending" | "promoted";

type McpMutationProposal = Readonly<{
  id: string;
  tenant: TenantIdentity;
  actorId: string;
  artifact: MigrationArtifact;
  destructive: boolean;
  state: MutationState;
  previewSchemaHash: string | null;
}>;

export type McpApprovalDecision = Readonly<{
  approvalId: string;
  state: "pending" | "approved" | "rejected";
  expiresAt: number;
  tenant: TenantIdentity;
  proposalId: string;
  artifactHash: string;
  parentSchemaHash: string;
  previewSchemaHash: string;
}>;

export type McpStudioApprovalHook = Readonly<{
  request(
    input: Readonly<{
      tenant: TenantIdentity;
      proposalId: string;
      artifactHash: string;
      parentSchemaHash: string;
      previewSchemaHash: string;
      actorId: string;
    }>,
  ): Promise<McpApprovalDecision>;
  get(approvalId: string): Promise<McpApprovalDecision>;
}>;

export type McpMutationWorkflow = Readonly<{
  createPreview(
    context: TenantContext,
    input: Readonly<{ tenant: TenantIdentity; ttlSeconds: number; idempotencyKey: string }>,
  ): Promise<Readonly<{ tenant: TenantIdentity; expiresAt: number }>>;
  propose(
    context: TenantContext,
    project: McpProject,
    input: Readonly<{ migrationId: string; idempotencyKey: string; sql: string }>,
  ): Promise<McpMutationProposal>;
  apply(context: TenantContext, proposalId: string): Promise<McpMutationProposal>;
  validate(
    context: TenantContext,
    project: McpProject,
    proposalId: string,
  ): Promise<McpMutationProposal>;
  requestPromotion(
    context: TenantContext,
    proposalId: string,
  ): Promise<
    Readonly<{
      proposal: McpMutationProposal;
      approval: McpApprovalDecision;
      promotion: "pending" | "rejected" | "applied" | "replayed";
    }>
  >;
  close(): void;
}>;

export type McpMutationWorkflowOptions = Readonly<{
  catalogPath: string;
  catalogDirectory: string;
  branches: Pick<BranchService, "createBranch" | "applyToBranch" | "promote">;
  approvals: McpStudioApprovalHook;
  audit: McpMutationAuditSink;
  now?: () => number;
}>;

export type McpMutationAuditEvent = Readonly<{
  action:
    | "mcp.preview.create"
    | "mcp.migration.propose"
    | "mcp.migration.apply"
    | "mcp.migration.validate"
    | "mcp.promotion.request"
    | "mcp.promotion.execute";
  actorId: string;
  tenant: TenantIdentity;
  correlationId: string;
  proposalId: string | null;
  artifactHash: string | null;
  occurredAt: number;
}>;

export type McpMutationAuditSink = Readonly<{
  record(event: McpMutationAuditEvent): void | Promise<void>;
}>;

export type McpTokenVerifier = Readonly<{
  verifyAccessToken(token: string): Promise<VerifiedAuthAccessToken>;
}>;

export type McpCapabilityStore = Readonly<{
  listCapabilities(
    input: Readonly<{ tenant: TenantIdentity; actorId: string }>,
  ): Promise<readonly Capability[]>;
}>;

export type McpHttpDependencies = McpDependencies &
  Readonly<{
    tokenVerifier: McpTokenVerifier;
    capabilityStore: McpCapabilityStore;
    protectedResource: McpProtectedResource;
  }>;

export type McpProtectedResource = Readonly<{
  resourceUrl: string;
  authorizationServerUrl: string;
}>;

type MigrationSummary = Readonly<{
  id: string;
  hash: string;
  actorId: string;
  appliedSchemaHash: string;
}>;

const safeLogEventPattern = /^[a-z][a-z0-9_.:-]{1,127}$/;
const safeCorrelationIdPattern = /^[0-9a-f-]{8,64}$/i;

export function createMcpServer(context: TenantContext, dependencies: McpDependencies): McpServer {
  const now = dependencies.now ?? Date.now;
  requireReadCapability(context, now());

  const server = new McpServer({ name: "mekka-read-only", version: "0.1.0" });
  const project = async (): Promise<McpProject> => {
    requireReadCapability(context, now());
    return resolveAuthorizedProject(context, dependencies);
  };

  server.registerResource(
    "schema-current",
    "schema://current",
    { mimeType: "application/json", description: "Current public schema manifest." },
    async () => resourceJson("schema://current", inspectSchema(await project())),
  );
  server.registerResource(
    "schema-branch",
    new ResourceTemplate("schema://branch/{branchId}", { list: undefined }),
    { mimeType: "application/json", description: "Schema for the authenticated branch only." },
    async (uri, variables) => {
      if (variables.branchId !== context.tenant.branchId) throw new ProtocolError("forbidden");
      return resourceJson(uri.href, inspectSchema(await project()));
    },
  );
  server.registerResource(
    "policies-current",
    "policies://current",
    {
      mimeType: "application/json",
      description: "Sanitized policy summary for the authenticated branch.",
    },
    async () => resourceJson("policies://current", policySummary((await project()).policies)),
  );
  server.registerResource(
    "migrations-history",
    "migrations://history",
    { mimeType: "application/json", description: "Migration metadata without SQL text." },
    async () => resourceJson("migrations://history", listMigrations(await project())),
  );
  server.registerResource(
    "logs-recent",
    "logs://recent",
    {
      mimeType: "application/json",
      description: "Log metadata; untrusted message text is withheld.",
    },
    async () => {
      requireReadCapability(context, now());
      return resourceJson("logs://recent", sanitizedLogs(await dependencies.listLogs(context)));
    },
  );
  server.registerResource(
    "capabilities-session",
    "capabilities://session",
    {
      mimeType: "application/json",
      description: "Read-only capabilities active for this MCP session.",
    },
    async () => {
      requireReadCapability(context, now());
      return resourceJson("capabilities://session", capabilitySummary(context, now()));
    },
  );

  server.registerTool(
    "inspect_schema",
    {
      description: "Read the authenticated branch schema manifest.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolJson(inspectSchema(await project())),
  );
  server.registerTool(
    "explain_query",
    {
      description:
        "Compile a constrained read query without executing it or exposing bound values.",
      inputSchema: {
        table: z.string().min(1).max(128),
        query: z.string().max(8_192).default(""),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ table, query }) => {
      const authorizedProject = await project();
      const manifest = buildSchemaManifest(authorizedProject.storage);
      const ast = parseQuery(manifest, table, query);
      const statement = compileSelect(manifest, ast);
      return toolJson({
        schemaHash: manifest.hash,
        table: ast.table,
        selectedColumns: ast.select.kind === "all" ? "all" : ast.select.columns,
        filterCount: ast.filter.terms.length,
        order: ast.order,
        limit: ast.limit,
        offset: ast.offset,
        sqlTemplate: statement.sql,
        parameterCount: statement.parameters?.length ?? 0,
        valuesIncluded: false,
      });
    },
  );
  server.registerTool(
    "list_migrations",
    {
      description: "List applied migration metadata for the authenticated branch without SQL text.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolJson(listMigrations(await project())),
  );
  server.registerTool(
    "get_policy_summary",
    {
      description: "Read a sanitized summary of policy actions and fields.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => toolJson(policySummary((await project()).policies)),
  );
  server.registerTool(
    "create_preview_branch",
    {
      description:
        "Create a short-lived isolated preview branch from the authenticated parent branch.",
      inputSchema: {
        environmentId: z.string().min(3).max(64),
        branchId: z.string().min(3).max(64),
        generation: z.number().int().positive(),
        ttlSeconds: z
          .number()
          .int()
          .min(60)
          .max(60 * 60 * 24 * 30),
        idempotencyKey: z.string().min(8).max(128),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const workflow = requireMutations(dependencies);
      requireMutationCapability(context, mcpPreviewCreateAction, now());
      const previewTenant = parseTenantIdentity({
        organizationId: context.tenant.organizationId,
        projectId: context.tenant.projectId,
        environmentId: input.environmentId,
        branchId: input.branchId,
        generation: input.generation,
      });
      const created = await workflow.createPreview(context, { ...input, tenant: previewTenant });
      return toolJson({ preview: { tenant: created.tenant, expiresAt: created.expiresAt } });
    },
  );
  server.registerTool(
    "propose_migration",
    {
      description:
        "Create a branch-bound migration plan. It does not apply DDL or request production access.",
      inputSchema: {
        migrationId: z.string().min(3).max(128),
        idempotencyKey: z.string().min(8).max(128),
        sql: z.string().min(1).max(16_384),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (input) => {
      const workflow = requireMutations(dependencies);
      requireMutationCapability(context, mcpPreviewProposeAction, now());
      const proposal = await workflow.propose(context, await project(), input);
      return toolJson(proposalSummary(proposal));
    },
  );
  server.registerTool(
    "apply_to_preview",
    {
      description: "Apply a previously proposed migration to its exact preview branch only.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ proposalId }) => {
      const workflow = requireMutations(dependencies);
      requireMutationCapability(context, mcpPreviewApplyAction, now());
      return toolJson(proposalSummary(await workflow.apply(context, proposalId)));
    },
  );
  server.registerTool(
    "validate_changes",
    {
      description: "Validate the applied preview migration against the exact preview schema.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ proposalId }) => {
      const workflow = requireMutations(dependencies);
      requireMutationCapability(context, mcpPreviewValidateAction, now());
      return toolJson(
        proposalSummary(await workflow.validate(context, await project(), proposalId)),
      );
    },
  );
  server.registerTool(
    "request_promotion",
    {
      description:
        "Request Studio approval for a validated preview migration. Production mutation requires a separate step-up capability after approval.",
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ proposalId }) => {
      const workflow = requireMutations(dependencies);
      requireMutationCapability(context, mcpPromotionRequestAction, now());
      const result = await workflow.requestPromotion(context, proposalId);
      return toolJson({
        proposal: proposalSummary(result.proposal),
        approval: approvalSummary(result.approval),
        promotion: result.promotion,
      });
    },
  );

  return server;
}

export async function openMcpMutationWorkflow(
  options: McpMutationWorkflowOptions,
): Promise<McpMutationWorkflow> {
  const catalogDirectory = resolve(options.catalogDirectory);
  const catalogPath = resolve(options.catalogPath);
  const catalogRelativePath = relative(catalogDirectory, catalogPath);
  if (
    catalogRelativePath === "" ||
    catalogRelativePath.startsWith("..") ||
    isAbsolute(catalogRelativePath)
  ) {
    throw new ProtocolError("infrastructure");
  }
  await mkdir(dirname(catalogPath), { recursive: true });
  const catalog = new Database(catalogPath, { strict: true });
  const now = options.now ?? Date.now;
  try {
    catalog.run("PRAGMA foreign_keys = ON");
    catalog.run("PRAGMA journal_mode = WAL");
    catalog.run("PRAGMA synchronous = FULL");
    catalog.run(`CREATE TABLE IF NOT EXISTS mcp_preview (
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, generation INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      actor_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('creating', 'created')),
      expires_at INTEGER, PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation),
      UNIQUE (organization_id, project_id, environment_id, branch_id, generation, idempotency_key)
    ) STRICT`);
    catalog.run(`CREATE TABLE IF NOT EXISTS mcp_mutation_proposal (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, generation INTEGER NOT NULL, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      artifact_json TEXT NOT NULL, destructive INTEGER NOT NULL, state TEXT NOT NULL
        CHECK (state IN ('proposed', 'applied', 'validated', 'promotion_pending', 'promoted')),
      preview_schema_hash TEXT, approval_id TEXT, created_at INTEGER NOT NULL,
      UNIQUE (organization_id, project_id, environment_id, branch_id, generation, idempotency_key)
    ) STRICT`);
    catalog.run(`CREATE TABLE IF NOT EXISTS mcp_mutation_audit (
      action TEXT NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL, branch_id TEXT NOT NULL, generation INTEGER NOT NULL,
      correlation_id TEXT NOT NULL, event_json TEXT NOT NULL, delivered_at INTEGER,
      PRIMARY KEY (action, organization_id, project_id, environment_id, branch_id, generation, correlation_id)
    ) STRICT`);
  } catch (error) {
    catalog.close(false);
    throw error;
  }

  return Object.freeze({
    async createPreview(context, input) {
      const tenant = parseTenantIdentity(input.tenant);
      const key = tenantParameters(tenant);
      const existing = catalog
        .query<
          PreviewRow,
          TenantParameters
        >(`SELECT state, expires_at AS expiresAt, actor_id AS actorId,
          idempotency_key AS idempotencyKey FROM mcp_preview WHERE ${tenantWhere}`)
        .get(...key);
      if (existing) {
        if (
          existing.actorId !== context.actor.id ||
          existing.idempotencyKey !== input.idempotencyKey
        ) {
          throw new ProtocolError("conflict");
        }
        if (existing.state !== "created" || existing.expiresAt === null)
          throw new ProtocolError("conflict");
        return Object.freeze({ tenant, expiresAt: existing.expiresAt });
      }
      try {
        catalog
          .query<never, [...TenantParameters, string, string]>(`INSERT INTO mcp_preview (
            organization_id, project_id, environment_id, branch_id, generation, idempotency_key, actor_id, state
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'creating')`)
          .run(...key, input.idempotencyKey, context.actor.id);
      } catch {
        throw new ProtocolError("conflict");
      }
      try {
        const result = await options.branches.createBranch(
          {
            tenant,
            parentTenant: context.tenant,
            ttlSeconds: input.ttlSeconds,
            idempotencyKey: input.idempotencyKey,
          },
          context.actor.id,
          context.correlationId,
        );
        catalog
          .query<
            never,
            [number, ...TenantParameters]
          >(`UPDATE mcp_preview SET state = 'created', expires_at = ?
            WHERE ${tenantWhere} AND state = 'creating'`)
          .run(result.branch.expiresAt, ...key);
        await recordMutationAudit(
          catalog,
          options,
          "mcp.preview.create",
          context,
          null,
          null,
          now(),
        );
        return Object.freeze({ tenant, expiresAt: result.branch.expiresAt });
      } catch (error) {
        catalog
          .query<never, TenantParameters>(
            `DELETE FROM mcp_preview WHERE ${tenantWhere} AND state = 'creating'`,
          )
          .run(...key);
        throw error;
      }
    },
    async propose(context, project, input) {
      const existing = catalog
        .query<
          ProposalRow,
          [...TenantParameters, string]
        >(`SELECT ${proposalColumns} FROM mcp_mutation_proposal
          WHERE ${tenantWhere} AND idempotency_key = ?`)
        .get(...tenantParameters(context.tenant), input.idempotencyKey);
      if (existing) {
        const proposal = proposalFromRow(existing);
        if (proposal.actorId !== context.actor.id) throw new ProtocolError("forbidden");
        return proposal;
      }
      const artifact = createMigrationArtifact({
        id: input.migrationId,
        actorId: context.actor.id,
        idempotencyKey: input.idempotencyKey,
        expectedSchemaHash: buildSchemaManifest(project.storage).hash,
        sql: input.sql,
      });
      const proposal = Object.freeze({
        id: crypto.randomUUID(),
        tenant: context.tenant,
        actorId: context.actor.id,
        artifact,
        destructive: isDestructiveMigration(artifact.sql),
        state: "proposed" as const,
        previewSchemaHash: null,
      });
      try {
        catalog
          .query<never, (string | number | null)[]>(`INSERT INTO mcp_mutation_proposal (
          id, organization_id, project_id, environment_id, branch_id, generation, actor_id, idempotency_key,
          artifact_json, destructive, state, preview_schema_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?)`)
          .run(
            proposal.id,
            ...tenantParameters(proposal.tenant),
            proposal.actorId,
            input.idempotencyKey,
            JSON.stringify(artifact),
            proposal.destructive ? 1 : 0,
            now(),
          );
      } catch {
        throw new ProtocolError("conflict");
      }
      await recordMutationAudit(
        catalog,
        options,
        "mcp.migration.propose",
        context,
        proposal.id,
        proposal.artifact.hash,
        now(),
      );
      return proposal;
    },
    async apply(context, proposalId) {
      const proposal = requireProposal(catalog, proposalId, context);
      if (
        proposal.state === "applied" ||
        proposal.state === "validated" ||
        proposal.state === "promotion_pending" ||
        proposal.state === "promoted"
      )
        return proposal;
      if (proposal.state !== "proposed") throw new ProtocolError("conflict");
      const result = await options.branches.applyToBranch(
        proposal.tenant,
        proposal.artifact,
        context.actor.id,
        context.correlationId,
      );
      catalog
        .query<
          never,
          [string, string]
        >(`UPDATE mcp_mutation_proposal SET state = 'applied', preview_schema_hash = ?
        WHERE id = ? AND state = 'proposed'`)
        .run(result.schemaHash, proposal.id);
      const applied = requireProposal(catalog, proposal.id, context);
      await recordMutationAudit(
        catalog,
        options,
        "mcp.migration.apply",
        context,
        applied.id,
        applied.artifact.hash,
        now(),
      );
      return applied;
    },
    async validate(context, project, proposalId) {
      const proposal = requireProposal(catalog, proposalId, context);
      if (
        proposal.state === "validated" ||
        proposal.state === "promotion_pending" ||
        proposal.state === "promoted"
      )
        return proposal;
      if (proposal.state !== "applied" || proposal.previewSchemaHash === null)
        throw new ProtocolError("conflict");
      if (buildSchemaManifest(project.storage).hash !== proposal.previewSchemaHash)
        throw new ProtocolError("conflict");
      catalog
        .query<never, [string]>(
          "UPDATE mcp_mutation_proposal SET state = 'validated' WHERE id = ? AND state = 'applied'",
        )
        .run(proposal.id);
      const validated = requireProposal(catalog, proposal.id, context);
      await recordMutationAudit(
        catalog,
        options,
        "mcp.migration.validate",
        context,
        validated.id,
        validated.artifact.hash,
        now(),
      );
      return validated;
    },
    async requestPromotion(context, proposalId) {
      let proposal = requireProposal(catalog, proposalId, context);
      if (proposal.state === "promoted")
        return Object.freeze({
          proposal,
          approval: await requireApproval(catalog, proposal.id, options.approvals, now),
          promotion: "replayed" as const,
        });
      if (proposal.state !== "validated" && proposal.state !== "promotion_pending")
        throw new ProtocolError("conflict");
      if (proposal.previewSchemaHash === null) throw new ProtocolError("conflict");
      let approval =
        proposal.state === "promotion_pending"
          ? await requireApproval(catalog, proposal.id, options.approvals, now)
          : null;
      if (approval === null) {
        approval = await options.approvals.request({
          tenant: proposal.tenant,
          proposalId: proposal.id,
          artifactHash: proposal.artifact.hash,
          parentSchemaHash: proposal.artifact.expectedSchemaHash,
          previewSchemaHash: proposal.previewSchemaHash,
          actorId: context.actor.id,
        });
        validateApproval(approval, proposal, now());
        catalog
          .query<never, [string, string]>(
            "UPDATE mcp_mutation_proposal SET state = 'promotion_pending', approval_id = ? WHERE id = ? AND state = 'validated'",
          )
          .run(approval.approvalId, proposal.id);
        proposal = requireProposal(catalog, proposal.id, context);
        await recordMutationAudit(
          catalog,
          options,
          "mcp.promotion.request",
          context,
          proposal.id,
          proposal.artifact.hash,
          now(),
        );
      }
      if (
        approval.state !== "approved" ||
        !hasCapability(context, mcpPromotionExecuteAction, now())
      ) {
        return Object.freeze({
          proposal,
          approval,
          promotion: approval.state === "rejected" ? ("rejected" as const) : ("pending" as const),
        });
      }
      const result = await options.branches.promote(
        proposal.tenant,
        proposal.artifact.hash,
        `mcp-${proposal.id}`,
        context.actor.id,
        context.correlationId,
      );
      catalog
        .query<never, [string]>(
          "UPDATE mcp_mutation_proposal SET state = 'promoted' WHERE id = ? AND state = 'promotion_pending'",
        )
        .run(proposal.id);
      const promoted = requireProposal(catalog, proposal.id, context);
      await recordMutationAudit(
        catalog,
        options,
        "mcp.promotion.execute",
        context,
        promoted.id,
        promoted.artifact.hash,
        now(),
      );
      return Object.freeze({ proposal: promoted, approval, promotion: result.status });
    },
    close() {
      catalog.close(false);
    },
  });
}

type TenantParameters = [string, string, string, string, number];
type PreviewRow = Readonly<{
  state: "creating" | "created";
  expiresAt: number | null;
  actorId: string;
  idempotencyKey: string;
}>;
type ProposalRow = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
  actorId: string;
  artifactJson: string;
  destructive: number;
  state: MutationState;
  previewSchemaHash: string | null;
}>;

const tenantWhere =
  "organization_id = ? AND project_id = ? AND environment_id = ? AND branch_id = ? AND generation = ?";
const proposalColumns = `id, organization_id AS organizationId, project_id AS projectId,
  environment_id AS environmentId, branch_id AS branchId, generation, actor_id AS actorId,
  artifact_json AS artifactJson, destructive, state, preview_schema_hash AS previewSchemaHash`;

function requireMutations(dependencies: McpDependencies): McpMutationWorkflow {
  if (!dependencies.mutations) throw new ProtocolError("unsupported");
  return dependencies.mutations;
}

function requireMutationCapability(context: TenantContext, action: string, now: number): void {
  if (!hasCapability(context, action, now)) throw new ProtocolError("forbidden");
}

function tenantParameters(tenant: TenantIdentity): TenantParameters {
  return [
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ];
}

function requireProposal(
  database: Database,
  proposalId: string,
  context: TenantContext,
): McpMutationProposal {
  const row = database
    .query<ProposalRow, [string]>(
      `SELECT ${proposalColumns} FROM mcp_mutation_proposal WHERE id = ?`,
    )
    .get(proposalId);
  if (!row) throw new ProtocolError("conflict");
  const proposal = proposalFromRow(row);
  if (!sameTenant(proposal.tenant, context.tenant) || proposal.actorId !== context.actor.id)
    throw new ProtocolError("forbidden");
  return proposal;
}

function proposalFromRow(row: ProposalRow): McpMutationProposal {
  let artifact: MigrationArtifact;
  try {
    artifact = JSON.parse(row.artifactJson) as MigrationArtifact;
  } catch {
    throw new ProtocolError("infrastructure");
  }
  if (
    !/^[a-f0-9]{64}$/.test(artifact.hash) ||
    !/^[a-f0-9]{64}$/.test(artifact.expectedSchemaHash)
  ) {
    throw new ProtocolError("infrastructure");
  }
  return Object.freeze({
    id: row.id,
    tenant: parseTenantIdentity({
      organizationId: row.organizationId,
      projectId: row.projectId,
      environmentId: row.environmentId,
      branchId: row.branchId,
      generation: row.generation,
    }),
    actorId: row.actorId,
    artifact,
    destructive: row.destructive === 1,
    state: row.state,
    previewSchemaHash: row.previewSchemaHash,
  });
}

async function requireApproval(
  database: Database,
  proposalId: string,
  approvals: McpStudioApprovalHook,
  now: () => number,
): Promise<McpApprovalDecision> {
  const row = database
    .query<{ approvalId: string | null }, [string]>(
      "SELECT approval_id AS approvalId FROM mcp_mutation_proposal WHERE id = ?",
    )
    .get(proposalId);
  if (!row?.approvalId) throw new ProtocolError("conflict");
  let approval: McpApprovalDecision;
  try {
    approval = await approvals.get(row.approvalId);
  } catch {
    throw new ProtocolError("infrastructure");
  }
  const proposal = database
    .query<ProposalRow, [string]>(
      `SELECT ${proposalColumns} FROM mcp_mutation_proposal WHERE id = ?`,
    )
    .get(proposalId);
  if (!proposal) throw new ProtocolError("conflict");
  validateApproval(approval, proposalFromRow(proposal), now());
  return approval;
}

function validateApproval(
  approval: McpApprovalDecision,
  proposal: McpMutationProposal,
  now: number,
): void {
  if (
    approval.expiresAt <= now ||
    !sameTenant(approval.tenant, proposal.tenant) ||
    approval.proposalId !== proposal.id ||
    approval.artifactHash !== proposal.artifact.hash ||
    approval.parentSchemaHash !== proposal.artifact.expectedSchemaHash ||
    approval.previewSchemaHash !== proposal.previewSchemaHash ||
    (approval.state !== "pending" && approval.state !== "approved" && approval.state !== "rejected")
  )
    throw new ProtocolError("conflict");
}

async function recordMutationAudit(
  database: Database,
  options: McpMutationWorkflowOptions,
  action: McpMutationAuditEvent["action"],
  context: TenantContext,
  proposalId: string | null,
  artifactHash: string | null,
  occurredAt: number,
): Promise<void> {
  const event = Object.freeze({
    action,
    actorId: context.actor.id,
    tenant: context.tenant,
    correlationId: context.correlationId,
    proposalId,
    artifactHash,
    occurredAt,
  });
  database
    .query<never, (string | number)[]>(`INSERT OR IGNORE INTO mcp_mutation_audit (
      action, organization_id, project_id, environment_id, branch_id, generation,
      correlation_id, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(action, ...tenantParameters(context.tenant), context.correlationId, JSON.stringify(event));
  try {
    await options.audit.record(event);
    database
      .query<never, [number, string, ...TenantParameters, string]>(`UPDATE mcp_mutation_audit
        SET delivered_at = ? WHERE action = ? AND ${tenantWhere} AND correlation_id = ?`)
      .run(occurredAt, action, ...tenantParameters(context.tenant), context.correlationId);
  } catch {
    // The durable ledger is authoritative; external audit delivery is best effort.
  }
}

function isDestructiveMigration(sql: string): boolean {
  return /^DROP (?:TABLE|INDEX)\b/i.test(sql.trim());
}

function proposalSummary(proposal: McpMutationProposal): Readonly<Record<string, unknown>> {
  return Object.freeze({
    proposalId: proposal.id,
    tenant: proposal.tenant,
    state: proposal.state,
    plan: Object.freeze({
      artifactHash: proposal.artifact.hash,
      expectedSchemaHash: proposal.artifact.expectedSchemaHash,
      operation: migrationOperation(proposal.artifact.sql),
      destructive: proposal.destructive,
      sqlIncluded: false,
    }),
    previewSchemaHash: proposal.previewSchemaHash,
  });
}

function approvalSummary(approval: McpApprovalDecision): Readonly<Record<string, unknown>> {
  return Object.freeze({
    approvalId: approval.approvalId,
    state: approval.state,
    expiresAt: approval.expiresAt,
    boundArtifactHash: approval.artifactHash,
    boundParentSchemaHash: approval.parentSchemaHash,
    boundPreviewSchemaHash: approval.previewSchemaHash,
  });
}

function migrationOperation(sql: string): string {
  const statement = sql
    .trim()
    .split(/\s+/, 3)
    .map((part) => part.toUpperCase());
  if (statement[0] === "ALTER" && statement[1] === "TABLE") return "alter_table";
  if (statement[0] === "CREATE" && statement[1] === "TABLE") return "create_table";
  if (statement[0] === "CREATE" && statement[1] === "INDEX") return "create_index";
  if (statement[0] === "DROP" && statement[1] === "TABLE") return "drop_table";
  if (statement[0] === "DROP" && statement[1] === "INDEX") return "drop_index";
  return "schema_change";
}

export async function startMcpStdio(
  context: TenantContext,
  dependencies: McpDependencies,
): Promise<void> {
  const server = createMcpServer(context, dependencies);
  await server.connect(
    new StdioServerTransport(undefined, undefined, { maxBufferSize: 1_000_000 }),
  );
}

export async function createMcpHttpResponse(
  request: Request,
  dependencies: McpHttpDependencies,
): Promise<Response> {
  let protectedResource: ReturnType<typeof parseProtectedResource> | undefined;
  try {
    protectedResource = parseProtectedResource(dependencies.protectedResource);
    const url = new URL(request.url);
    if (
      url.pathname === `/.well-known/oauth-protected-resource${protectedResource.resource.pathname}`
    ) {
      return protectedResourceMetadata(protectedResource);
    }
    if (url.href !== protectedResource.resource.href) throw new ProtocolError("forbidden");
    const context = await authenticateHttpRequest(request, dependencies);
    const server = createMcpServer(context, dependencies);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    return unauthorizedResponse(error, protectedResource);
  }
}

async function authenticateHttpRequest(
  request: Request,
  dependencies: Pick<McpHttpDependencies, "tokenVerifier" | "capabilityStore">,
): Promise<TenantContext> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
  if (!match?.[1]) throw new ProtocolError("auth");

  let verified: VerifiedAuthAccessToken;
  try {
    verified = await dependencies.tokenVerifier.verifyAccessToken(match[1]);
  } catch {
    throw new ProtocolError("auth");
  }

  try {
    const capabilities = await dependencies.capabilityStore.listCapabilities({
      tenant: verified.tenant,
      actorId: verified.userId,
    });
    return createTenantContext({
      tenant: verified.tenant,
      actor: { kind: "agent", id: verified.userId },
      capabilities,
      correlationId: createCorrelationId(),
    });
  } catch (error) {
    if (error instanceof ProtocolError) throw new ProtocolError("auth");
    throw error;
  }
}

function resolveAuthorizedProject(
  context: TenantContext,
  dependencies: McpDependencies,
): Promise<McpProject> {
  return Promise.resolve(dependencies.resolveProject(context)).then((project) => {
    if (!sameTenant(project.tenant, context.tenant)) throw new ProtocolError("forbidden");
    return project;
  });
}

function inspectSchema(project: McpProject): SchemaManifest {
  return buildSchemaManifest(project.storage);
}

function listMigrations(project: McpProject): readonly MigrationSummary[] {
  const table = project.storage.execute<{ name: StorageValue }>({
    sql: "SELECT name FROM pragma_table_list WHERE schema = ? AND type = ? AND name = ?",
    parameters: ["main", "table", "_mekka_migrations"],
  }).rows[0];
  if (table?.name !== "_mekka_migrations") return Object.freeze([]);

  const rows = project.storage.execute<{
    id: StorageValue;
    hash: StorageValue;
    actorId: StorageValue;
    appliedSchemaHash: StorageValue;
  }>({
    sql: "SELECT id, hash, actor_id AS actorId, applied_schema_hash AS appliedSchemaHash FROM _mekka_migrations WHERE state = ? ORDER BY id LIMIT 100",
    parameters: ["applied"],
  }).rows;
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        id: readSafeString(row.id),
        hash: readHash(row.hash),
        actorId: readSafeString(row.actorId),
        appliedSchemaHash: readHash(row.appliedSchemaHash),
      }),
    ),
  );
}

function policySummary(document: PolicyDocument): Readonly<Record<string, unknown>> {
  if (document.formatVersion !== policyFormatVersion) throw new ProtocolError("infrastructure");
  return Object.freeze({
    formatVersion: document.formatVersion,
    tables: Object.freeze(
      document.tables.map((table) =>
        Object.freeze({
          table: table.table,
          actions: Object.freeze(
            table.rules.map((rule) =>
              Object.freeze({
                name: rule.name,
                action: rule.action,
                allowedFields: Object.freeze([...(rule.fields?.allow ?? [])]),
                deniedFields: Object.freeze([...(rule.fields?.deny ?? [])]),
                hasUsingPredicate: rule.using !== undefined,
                hasCheckPredicate: rule.check !== undefined,
              }),
            ),
          ),
        }),
      ),
    ),
  });
}

function sanitizedLogs(entries: readonly McpLogEntry[]): Readonly<Record<string, unknown>> {
  return Object.freeze({
    provenance: Object.freeze({ kind: "untrusted_log", instructionSafe: false }),
    entries: Object.freeze(
      entries.slice(0, 100).map((entry) =>
        Object.freeze({
          occurredAt: Number.isSafeInteger(entry.occurredAt) ? entry.occurredAt : 0,
          level: entry.level,
          event: safeLogEventPattern.test(entry.event) ? entry.event : "unknown",
          correlationId: safeCorrelationIdPattern.test(entry.correlationId)
            ? entry.correlationId
            : "redacted",
          message: "[untrusted log text withheld]",
          attributes: "[untrusted log attributes withheld]",
        }),
      ),
    ),
  });
}

function capabilitySummary(context: TenantContext, now: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    tenant: context.tenant,
    capabilities: Object.freeze(
      context.capabilities
        .filter(
          (capability) =>
            capability.expiresAt > now && capability.actions.includes(mcpCapabilityAction),
        )
        .map((capability) =>
          Object.freeze({
            id: capability.id,
            actions: capability.actions,
            expiresAt: capability.expiresAt,
          }),
        ),
    ),
  });
}

function requireReadCapability(context: TenantContext, now: number): void {
  if (!hasCapability(context, mcpCapabilityAction, now)) throw new ProtocolError("forbidden");
}

function resourceJson(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}

function toolJson(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function unauthorizedResponse(
  error: unknown,
  protectedResource?: ReturnType<typeof parseProtectedResource>,
): Response {
  const status = error instanceof ProtocolError && error.code === "forbidden" ? 403 : 401;
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  if (status === 401 && protectedResource !== undefined) {
    const metadataUrl = new URL(
      `/.well-known/oauth-protected-resource${protectedResource.resource.pathname}`,
      protectedResource.resource,
    );
    headers.set("www-authenticate", `Bearer resource_metadata="${metadataUrl.href}"`);
  }
  return new Response(JSON.stringify({ error: status === 403 ? "forbidden" : "auth" }), {
    status,
    headers,
  });
}

function readSafeString(value: StorageValue): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new ProtocolError("infrastructure");
  }
  return value;
}

function readHash(value: StorageValue): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ProtocolError("infrastructure");
  }
  return value;
}

function parseProtectedResource(input: McpProtectedResource): Readonly<{
  resource: URL;
  authorizationServer: URL;
}> {
  const resource = new URL(input.resourceUrl);
  const authorizationServer = new URL(input.authorizationServerUrl);
  if (
    !isSecureOrigin(resource) ||
    !isSecureOrigin(authorizationServer) ||
    resource.hash ||
    resource.search ||
    authorizationServer.hash ||
    authorizationServer.search
  ) {
    throw new ProtocolError("infrastructure");
  }
  return Object.freeze({ resource, authorizationServer });
}

function protectedResourceMetadata(
  resource: Readonly<{ resource: URL; authorizationServer: URL }>,
): Response {
  return new Response(
    JSON.stringify({
      resource: resource.resource.href,
      authorization_servers: [resource.authorizationServer.href],
      bearer_methods_supported: ["header"],
      scopes_supported: [mcpCapabilityAction],
    }),
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
      },
    },
  );
}

function isSecureOrigin(url: URL): boolean {
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
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
