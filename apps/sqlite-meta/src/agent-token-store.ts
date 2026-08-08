import { Database } from "bun:sqlite";
import type { VerifiedAuthAccessToken } from "@mekka/auth-core";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";

type AgentTokenRecord = Readonly<{
  userId: string;
  sessionId: string;
  tokenId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  mode: AgentTokenMode;
}>;

export type AgentTokenMode = "read" | "write";

export type AgentTokenStore = Readonly<{
  issue(
    tokenHash: string,
    verified: VerifiedAuthAccessToken,
    expiresAt: number,
    mode?: AgentTokenMode,
  ): boolean;
  verify(tokenHash: string, now?: number): VerifiedAuthAccessToken | null;
  modeFor(tokenId: string, tenant: TenantIdentity, userId: string): AgentTokenMode | null;
  revokeSession(sessionId: string): void;
  cleanupExpired(now?: number, batchSize?: number): number;
  close(): void;
}>;

export function openAgentTokenStore(
  databasePath: string,
  maxActiveTokens = 10_000,
): AgentTokenStore {
  const database = new Database(databasePath, { strict: true });
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = NORMAL");
  database.run("PRAGMA busy_timeout = 5000");
  database.run(`
    CREATE TABLE IF NOT EXISTS _mekka_agent_access_token (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'write'))
    ) STRICT
  `);
  ensureModeColumn(database);
  database.run(
    "CREATE INDEX IF NOT EXISTS _mekka_agent_access_token_expiry_idx ON _mekka_agent_access_token (expires_at)",
  );
  database.run(
    "CREATE INDEX IF NOT EXISTS _mekka_agent_access_token_session_idx ON _mekka_agent_access_token (session_id)",
  );

  const issue = database.transaction(
    (
      tokenHash: string,
      verified: VerifiedAuthAccessToken,
      expiresAt: number,
      mode: AgentTokenMode = "read",
    ): boolean => {
      cleanupExpiredRows(database, Date.now(), 100);
      database
        .query<never, [string, string, string, string, string, number]>(`
          DELETE FROM _mekka_agent_access_token
          WHERE user_id = ? AND organization_id = ? AND project_id = ?
            AND environment_id = ? AND branch_id = ? AND generation = ?
        `)
        .run(
          verified.userId,
          verified.tenant.organizationId,
          verified.tenant.projectId,
          verified.tenant.environmentId,
          verified.tenant.branchId,
          verified.tenant.generation,
        );
      const count = database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM _mekka_agent_access_token")
        .get()?.count;
      if (count === undefined || count >= maxActiveTokens) return false;
      database
        .query<
          never,
          [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            number,
            number,
            AgentTokenMode,
          ]
        >(`
          INSERT INTO _mekka_agent_access_token (
            token_hash, user_id, session_id, token_id, organization_id, project_id,
            environment_id, branch_id, generation, issued_at, expires_at, mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          tokenHash,
          verified.userId,
          verified.sessionId,
          verified.tokenId,
          verified.tenant.organizationId,
          verified.tenant.projectId,
          verified.tenant.environmentId,
          verified.tenant.branchId,
          verified.tenant.generation,
          verified.issuedAt,
          expiresAt,
          mode,
        );
      return true;
    },
  );

  return Object.freeze({
    issue,
    verify(tokenHash, now = Date.now()) {
      const record = database
        .query<AgentTokenRecord, [string]>(`
          SELECT
            user_id AS userId,
            session_id AS sessionId,
            token_id AS tokenId,
            organization_id AS organizationId,
            project_id AS projectId,
            environment_id AS environmentId,
            branch_id AS branchId,
            generation,
            issued_at AS issuedAt,
            expires_at AS expiresAt
            , mode
          FROM _mekka_agent_access_token
          WHERE token_hash = ?
        `)
        .get(tokenHash);
      if (!record) return null;
      if (record.expiresAt <= now) {
        database
          .query<never, [string]>("DELETE FROM _mekka_agent_access_token WHERE token_hash = ?")
          .run(tokenHash);
        return null;
      }
      const tenant: TenantIdentity = parseTenantIdentity({
        organizationId: record.organizationId,
        projectId: record.projectId,
        environmentId: record.environmentId,
        branchId: record.branchId,
        generation: record.generation,
      });
      return Object.freeze({
        userId: record.userId,
        sessionId: record.sessionId,
        tokenId: record.tokenId,
        tenant,
        issuedAt: record.issuedAt,
        expiresAt: Math.floor(record.expiresAt / 1_000),
      });
    },
    modeFor(tokenId, tenant, userId) {
      const row = database
        .query<
          { mode: AgentTokenMode },
          [string, string, string, string, string, number, string, number]
        >(`
          SELECT mode FROM _mekka_agent_access_token
          WHERE token_id = ? AND organization_id = ? AND project_id = ?
            AND environment_id = ? AND branch_id = ? AND generation = ? AND user_id = ?
            AND expires_at > ?
        `)
        .get(
          tokenId,
          tenant.organizationId,
          tenant.projectId,
          tenant.environmentId,
          tenant.branchId,
          tenant.generation,
          userId,
          Date.now(),
        );
      return row?.mode ?? null;
    },
    revokeSession(sessionId) {
      database
        .query<never, [string]>("DELETE FROM _mekka_agent_access_token WHERE session_id = ?")
        .run(sessionId);
    },
    cleanupExpired(now = Date.now(), batchSize = 100) {
      return cleanupExpiredRows(database, now, batchSize);
    },
    close() {
      database.close(false);
    },
  });
}

function ensureModeColumn(database: Database): void {
  const columns = database
    .query<{ name: string }, []>("PRAGMA table_info('_mekka_agent_access_token')")
    .all();
  if (!columns.some((column) => column.name === "mode")) {
    database.run(
      "ALTER TABLE _mekka_agent_access_token ADD COLUMN mode TEXT NOT NULL DEFAULT 'read' CHECK (mode IN ('read', 'write'))",
    );
  }
}

function cleanupExpiredRows(database: Database, now: number, batchSize: number): number {
  const limit = Math.max(1, Math.min(1_000, Math.trunc(batchSize)));
  const expired = database
    .query<{ tokenHash: string }, [number, number]>(`
      SELECT token_hash AS tokenHash
      FROM _mekka_agent_access_token
      WHERE expires_at <= ?
      ORDER BY expires_at
      LIMIT ?
    `)
    .all(now, limit);
  if (expired.length === 0) return 0;
  const remove = database.transaction((rows: readonly { tokenHash: string }[]) => {
    const statement = database.query<never, [string]>(
      "DELETE FROM _mekka_agent_access_token WHERE token_hash = ?",
    );
    for (const row of rows) statement.run(row.tokenHash);
  });
  remove(expired);
  return expired.length;
}
