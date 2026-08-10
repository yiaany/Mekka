import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BranchService, openBranchService } from "@mekka/branch-core";
import {
  type McpApprovalDecision,
  type McpStudioApprovalHook,
  openMcpMutationWorkflow,
} from "@mekka/mcp";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";
import type { StorageAdapter } from "@mekka/storage-core";

export type McpApprovalRecord = McpApprovalDecision &
  Readonly<{
    actorId: string;
    sql: string;
    destructive: boolean;
    createdAt: number;
    executionConsumedAt: number | null;
  }>;

export type LocalMcpRuntime = Readonly<{
  branches: BranchService;
  mutations: Awaited<ReturnType<typeof openMcpMutationWorkflow>>;
  approvals: Readonly<{
    list(actorId: string): readonly McpApprovalRecord[];
    findBlocking(actorId: string): McpApprovalRecord | null;
    decide(
      approvalId: string,
      actorId: string,
      state: "approved" | "rejected",
    ): Readonly<{ approval: McpApprovalRecord; executionToken?: string }>;
    cleanupExpired(): void;
    close(): void;
  }>;
  cleanupExpired(): Promise<void>;
  close(): void;
}>;

export async function openLocalMcpRuntime(
  options: Readonly<{
    dataDirectory: string;
    productionTenant: TenantIdentity;
    resolveProductionStorage(): StorageAdapter;
    beforePreviewDelete(tenant: TenantIdentity): void | Promise<void>;
  }>,
): Promise<LocalMcpRuntime> {
  const root = join(options.dataDirectory, "mcp-runtime");
  const catalogDirectory = join(root, "catalog");
  const databaseDirectory = join(root, "branches");
  const checkpointDirectory = join(root, "checkpoints");
  const previewAuthDirectory = join(root, "preview-auth");
  await Promise.all([
    mkdir(catalogDirectory, { recursive: true }),
    mkdir(databaseDirectory, { recursive: true }),
    mkdir(checkpointDirectory, { recursive: true }),
    mkdir(previewAuthDirectory, { recursive: true }),
  ]);
  let mutationLocked = false;
  const branches = await openBranchService({
    catalogDirectory,
    catalogPath: join(catalogDirectory, "branches.sqlite"),
    databaseDirectory,
    checkpointDirectory,
    resolveParent(tenant) {
      if (!sameTenant(tenant, options.productionTenant)) {
        throw new Error("Preview parent tenant is invalid.");
      }
      return {
        tenant: options.productionTenant,
        storage: options.resolveProductionStorage(),
        production: true,
        withMutationLock<T>(operation: () => T): T {
          if (mutationLocked) throw new Error("Production mutation is already in progress.");
          mutationLocked = true;
          try {
            return operation();
          } finally {
            mutationLocked = false;
          }
        },
      };
    },
    credentials: {
      async issue({ tenant, credentialId, expiresAt }) {
        return Object.freeze({
          id: credentialId,
          token: randomBytes(32).toString("base64url"),
          url: `https://preview.invalid/${encodeURIComponent(tenant.branchId)}`,
          expiresAt,
          tenant,
        });
      },
      async revoke() {},
    },
    auth: {
      async create(tenant) {
        await mkdir(previewAuthPath(previewAuthDirectory, tenant), { recursive: true });
      },
      async delete(tenant) {
        await rm(previewAuthPath(previewAuthDirectory, tenant), { recursive: true, force: true });
      },
    },
    audit: { record() {} },
    beforeDelete: options.beforePreviewDelete,
  });
  const approvals = openApprovalStore(join(catalogDirectory, "approvals.sqlite"));
  const mutations = await openMcpMutationWorkflow({
    catalogDirectory,
    catalogPath: join(catalogDirectory, "mutations.sqlite"),
    branches,
    approvals: approvals.hook,
    audit: { record() {} },
  });
  return Object.freeze({
    branches,
    mutations,
    approvals,
    async cleanupExpired() {
      await branches.cleanupExpired();
      mutations.cleanupExpired();
      approvals.cleanupExpired();
    },
    close() {
      mutations.close();
      branches.close();
      approvals.close();
    },
  });
}

export function openApprovalStore(path: string) {
  const database = new Database(path, { strict: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = NORMAL");
  database.run("PRAGMA busy_timeout = 5000");
  database.run(`CREATE TABLE IF NOT EXISTS mcp_studio_approval (
    approval_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
    expires_at INTEGER NOT NULL, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    environment_id TEXT NOT NULL, branch_id TEXT NOT NULL, generation INTEGER NOT NULL,
    proposal_id TEXT NOT NULL UNIQUE, artifact_hash TEXT NOT NULL, parent_schema_hash TEXT NOT NULL,
    preview_schema_hash TEXT NOT NULL, actor_id TEXT NOT NULL, sql TEXT NOT NULL,
    destructive INTEGER NOT NULL CHECK (destructive IN (0, 1)), created_at INTEGER NOT NULL,
    execution_token_hash TEXT, execution_consumed_at INTEGER
  ) STRICT`);
  ensureApprovalColumn(database, "execution_token_hash", "TEXT");
  ensureApprovalColumn(database, "execution_consumed_at", "INTEGER");

  const hook: McpStudioApprovalHook = {
    async request(input) {
      const existing = readApprovalByProposal(database, input.proposalId);
      if (existing) return decision(existing);
      const approvalId = randomUUID();
      const createdAt = Date.now();
      database
        .query<never, (string | number)[]>(`INSERT INTO mcp_studio_approval (
          approval_id, state, expires_at, organization_id, project_id, environment_id, branch_id,
          generation, proposal_id, artifact_hash, parent_schema_hash, preview_schema_hash,
          actor_id, sql, destructive, created_at
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          approvalId,
          createdAt + 5 * 60_000,
          input.tenant.organizationId,
          input.tenant.projectId,
          input.tenant.environmentId,
          input.tenant.branchId,
          input.tenant.generation,
          input.proposalId,
          input.artifactHash,
          input.parentSchemaHash,
          input.previewSchemaHash,
          input.actorId,
          input.sql,
          input.destructive ? 1 : 0,
          createdAt,
        );
      return decision(requireApproval(database, approvalId));
    },
    async get(approvalId) {
      return decision(requireApproval(database, approvalId));
    },
    async consume(approvalId, executionToken, input) {
      const row = requireApproval(database, approvalId);
      const tokenHash = hashExecutionToken(executionToken);
      const timestamp = Date.now();
      if (
        row.state !== "approved" ||
        row.expiresAt <= timestamp ||
        row.executionTokenHash === null ||
        !safeHashEqual(row.executionTokenHash, tokenHash) ||
        row.proposalId !== input.proposalId ||
        row.artifactHash !== input.artifactHash ||
        row.parentSchemaHash !== input.parentSchemaHash ||
        row.previewSchemaHash !== input.previewSchemaHash ||
        row.actorId !== input.actorId ||
        !sameTenant(approvalTenant(row), input.tenant)
      ) {
        throw new Error("Execution grant is invalid, expired, or already consumed.");
      }
      const updated = database
        .query<never, [number, string, string, number]>(`UPDATE mcp_studio_approval
          SET execution_consumed_at = ? WHERE approval_id = ? AND execution_token_hash = ?
          AND execution_consumed_at IS NULL AND expires_at > ?`)
        .run(timestamp, approvalId, tokenHash, timestamp);
      if (
        updated.changes !== 1 &&
        requireApproval(database, approvalId).executionConsumedAt === null
      ) {
        throw new Error("Execution grant could not be consumed.");
      }
      return decision(requireApproval(database, approvalId));
    },
  };
  return Object.freeze({
    hook,
    list(actorId: string): readonly McpApprovalRecord[] {
      return Object.freeze(
        database
          .query<ApprovalRow, [string]>(
            `${approvalSelect} WHERE actor_id = ? ORDER BY created_at DESC LIMIT 100`,
          )
          .all(actorId)
          .map(record),
      );
    },
    findBlocking(actorId: string): McpApprovalRecord | null {
      const row = database
        .query<ApprovalRow, [string, number]>(`${approvalSelect}
          WHERE actor_id = ? AND state IN ('pending', 'approved')
          AND execution_consumed_at IS NULL AND expires_at > ?
          ORDER BY created_at DESC LIMIT 1`)
        .get(actorId, Date.now());
      return row === null ? null : record(row);
    },
    decide(approvalId: string, actorId: string, state: "approved" | "rejected") {
      const executionToken =
        state === "approved" ? randomBytes(32).toString("base64url") : undefined;
      const executionTokenHash = executionToken ? hashExecutionToken(executionToken) : null;
      const updated = database
        .query<never, [string, string | null, string, string, number]>(`UPDATE mcp_studio_approval
          SET state = ?, execution_token_hash = ?
          WHERE approval_id = ? AND actor_id = ? AND state = 'pending' AND expires_at > ?`)
        .run(state, executionTokenHash, approvalId, actorId, Date.now());
      if (updated.changes !== 1)
        throw new Error("Approval is missing, expired, or already decided.");
      return Object.freeze({
        approval: record(requireActorApproval(database, approvalId, actorId)),
        ...(executionToken ? { executionToken } : {}),
      });
    },
    cleanupExpired() {
      database
        .query<never, [number]>("DELETE FROM mcp_studio_approval WHERE expires_at <= ?")
        .run(Date.now());
    },
    close() {
      database.close(false);
    },
  });
}

type ApprovalRow = Readonly<{
  approvalId: string;
  state: "pending" | "approved" | "rejected";
  expiresAt: number;
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
  proposalId: string;
  artifactHash: string;
  parentSchemaHash: string;
  previewSchemaHash: string;
  actorId: string;
  sql: string;
  destructive: number;
  createdAt: number;
  executionTokenHash: string | null;
  executionConsumedAt: number | null;
}>;

const approvalSelect = `SELECT approval_id AS approvalId, state, expires_at AS expiresAt,
  organization_id AS organizationId, project_id AS projectId, environment_id AS environmentId,
  branch_id AS branchId, generation, proposal_id AS proposalId, artifact_hash AS artifactHash,
  parent_schema_hash AS parentSchemaHash, preview_schema_hash AS previewSchemaHash,
  actor_id AS actorId, sql, destructive, created_at AS createdAt,
  execution_token_hash AS executionTokenHash, execution_consumed_at AS executionConsumedAt
  FROM mcp_studio_approval`;

function readApprovalByProposal(database: Database, proposalId: string): ApprovalRow | null {
  return database
    .query<ApprovalRow, [string]>(`${approvalSelect} WHERE proposal_id = ?`)
    .get(proposalId);
}

function requireApproval(database: Database, approvalId: string): ApprovalRow {
  const row = database
    .query<ApprovalRow, [string]>(`${approvalSelect} WHERE approval_id = ?`)
    .get(approvalId);
  if (!row) throw new Error("Approval not found.");
  return row;
}

function requireActorApproval(
  database: Database,
  approvalId: string,
  actorId: string,
): ApprovalRow {
  const row = database
    .query<ApprovalRow, [string, string]>(
      `${approvalSelect} WHERE approval_id = ? AND actor_id = ?`,
    )
    .get(approvalId, actorId);
  if (!row) throw new Error("Approval not found.");
  return row;
}

function decision(row: ApprovalRow): McpApprovalDecision {
  return Object.freeze({
    approvalId: row.approvalId,
    state: row.state,
    expiresAt: row.expiresAt,
    tenant: approvalTenant(row),
    proposalId: row.proposalId,
    artifactHash: row.artifactHash,
    parentSchemaHash: row.parentSchemaHash,
    previewSchemaHash: row.previewSchemaHash,
  });
}

function record(row: ApprovalRow): McpApprovalRecord {
  return Object.freeze({
    ...decision(row),
    actorId: row.actorId,
    sql: row.sql,
    destructive: row.destructive === 1,
    createdAt: row.createdAt,
    executionConsumedAt: row.executionConsumedAt,
  });
}

function approvalTenant(row: ApprovalRow): TenantIdentity {
  return parseTenantIdentity({
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    branchId: row.branchId,
    generation: row.generation,
  });
}

function previewAuthPath(root: string, tenant: TenantIdentity): string {
  return join(
    root,
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    String(tenant.generation),
  );
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

function hashExecutionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function ensureApprovalColumn(database: Database, name: string, definition: string): void {
  const columns = database
    .query<{ name: string }, []>("PRAGMA table_info('mcp_studio_approval')")
    .all();
  if (!columns.some((column) => column.name === name)) {
    database.run(`ALTER TABLE mcp_studio_approval ADD COLUMN ${name} ${definition}`);
  }
}
