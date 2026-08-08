import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigrationArtifact } from "@mekka/migration-engine";
import {
  createTenantContext,
  parseCorrelationId,
  parseTenantIdentity,
  type TenantIdentity,
} from "@mekka/protocol";
import { buildSchemaManifest } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import {
  BranchError,
  type BranchAuditEvent,
  type BranchCredentialIssuer,
  type BranchService,
  branchCredentialDigest,
  engineCapabilities,
  openBranchService,
  type PreviewAuthStore,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  Bun.gc(true);
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
}, 15_000);

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 99) throw error;
      Bun.gc(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

type Fixture = Readonly<{
  directory: string;
  parent: TenantIdentity;
  parentStorage: StorageAdapter;
  service: BranchService;
  audits: BranchAuditEvent[];
  issued: Map<string, string>;
  revoked: string[];
  reopenService(): Promise<BranchService>;
  setNow(value: number): void;
}>;

function tenant(branchId: string, generation = 1, environmentId = "preview"): TenantIdentity {
  return parseTenantIdentity({
    organizationId: "org-alpha",
    projectId: "project-alpha",
    environmentId,
    branchId,
    generation,
  });
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-branch-"));
  temporaryDirectories.push(directory);
  const databaseDirectory = join(directory, "databases");
  const checkpointDirectory = join(directory, "checkpoints");
  const authDirectory = join(directory, "auth");
  await Promise.all([
    mkdir(databaseDirectory, { recursive: true }),
    mkdir(checkpointDirectory, { recursive: true }),
    mkdir(authDirectory, { recursive: true }),
  ]);
  const parent = tenant("main", 1, "production");
  const parentStorage = openStorageAdapter({
    databasePath: join(databaseDirectory, "production.sqlite"),
    databaseDirectory,
  });
  parentStorage.execute({
    sql: "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
  });
  parentStorage.execute({
    sql: "INSERT INTO accounts (id, name) VALUES (?, ?)",
    parameters: [1, "Ada"],
  });

  let clock = 1_800_000_000_000;
  const audits: BranchAuditEvent[] = [];
  const issued = new Map<string, string>();
  const revoked: string[] = [];
  const credentials: BranchCredentialIssuer = {
    async issue({ tenant: credentialTenant, credentialId, expiresAt }) {
      const scope = tenantScope(credentialTenant);
      const token = `preview-token-${scope}-00000000000000000000000000000000`;
      issued.set(scope, branchCredentialDigest(token));
      return Object.freeze({
        id: credentialId,
        token,
        url: `https://${credentialTenant.branchId}.preview.example.test`,
        expiresAt,
        tenant: credentialTenant,
      });
    },
    async revoke({ tenant: credentialTenant, credentialId }) {
      revoked.push(`${tenantScope(credentialTenant)}:${credentialId}`);
    },
  };
  const auth: PreviewAuthStore = {
    async create(authTenant, syntheticUsers) {
      const path = authPath(authDirectory, authTenant);
      await mkdir(join(path, ".."), { recursive: true });
      const database = new Database(path, { strict: true });
      try {
        database.run(
          "CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL) STRICT",
        );
        database.run("CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL) STRICT");
        database.run("CREATE TABLE account (id TEXT PRIMARY KEY, password TEXT) STRICT");
        const insert = database.query<never, [string, string, string]>(
          "INSERT INTO user (id, email, name) VALUES (?, ?, ?)",
        );
        for (const user of syntheticUsers) insert.run(user.id, user.email, user.name);
      } finally {
        database.close(false);
      }
    },
    async delete(authTenant) {
      await rm(join(authPath(authDirectory, authTenant), ".."), { force: true, recursive: true });
    },
  };
  const serviceOptions = {
    catalogPath: join(directory, "catalog", "branches.sqlite"),
    catalogDirectory: join(directory, "catalog"),
    databaseDirectory,
    checkpointDirectory,
    resolveParent(requested) {
      if (tenantScope(requested) !== tenantScope(parent)) {
        throw new BranchError("BRANCH_FORBIDDEN", "Unknown parent.");
      }
      return {
        tenant: parent,
        storage: parentStorage,
        production: true,
        withMutationLock(operation) {
          return operation();
        },
      };
    },
    credentials,
    auth,
    audit: {
      record(event) {
        audits.push(event);
      },
    },
    now: () => clock,
  } as const;
  const service = await openBranchService(serviceOptions);

  return {
    directory,
    parent,
    parentStorage,
    service,
    audits,
    issued,
    revoked,
    async reopenService(): Promise<BranchService> {
      return await openBranchService(serviceOptions);
    },
    setNow(value) {
      clock = value;
    },
  };
}

async function createBranch(
  fixture: Fixture,
  branchId = "preview-one",
  generation = 1,
  ttlSeconds = 300,
) {
  return await fixture.service.createBranch(
    {
      tenant: tenant(branchId, generation),
      parentTenant: fixture.parent,
      ttlSeconds,
      idempotencyKey: `create-${branchId}-${generation}`,
      syntheticUsers: [{ id: "preview-user", email: "preview@example.test", name: "Preview" }],
    },
    "actor-admin",
    "correlation-branch-0001",
  );
}

describe("preview branch lifecycle", () => {
  test("creates isolated schema-only data and Auth stores with separate branch credentials", async () => {
    const fixture = await createFixture();
    try {
      const first = await createBranch(fixture);
      const second = await createBranch(fixture, "preview-two");
      const firstStorage = openStorageAdapter({
        databasePath: first.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      try {
        expect(firstStorage.execute({ sql: "SELECT id, name FROM accounts" }).rows).toEqual([]);
        fixture.parentStorage.execute({
          sql: "INSERT INTO accounts (id, name) VALUES (?, ?)",
          parameters: [2, "Grace"],
        });
        expect(firstStorage.execute({ sql: "SELECT id FROM accounts" }).rows).toEqual([]);
      } finally {
        firstStorage.close();
      }

      const auth = new Database(authPath(join(fixture.directory, "auth"), first.branch.tenant), {
        readonly: true,
      });
      try {
        expect(auth.query("SELECT id, email FROM user").all()).toEqual([
          { id: "preview-user", email: "preview@example.test" },
        ]);
        expect(auth.query("SELECT * FROM session").all()).toEqual([]);
        expect(auth.query("SELECT * FROM account").all()).toEqual([]);
      } finally {
        auth.close(false);
      }

      expect(first.credential.token).not.toBe(second.credential.token);
      expect(fixture.issued.get(tenantScope(first.branch.tenant))).toBe(
        branchCredentialDigest(first.credential.token),
      );
      expect(JSON.stringify(first.branch)).not.toContain(first.credential.token);
      expect(first.branch.parentSchemaHash).toBe(buildSchemaManifest(fixture.parentStorage).hash);
      const checkpoint = openStorageAdapter({
        databasePath: first.branch.parentCheckpoint.checkpointPath,
        databaseDirectory: join(fixture.directory, "checkpoints"),
      });
      try {
        expect(checkpoint.execute({ sql: "SELECT id FROM accounts" }).rows).toEqual([]);
      } finally {
        checkpoint.close();
      }
      expect((await readFile(first.branch.databasePath)).includes(Buffer.from("Ada"))).toBe(false);
      expect(
        (await readFile(first.branch.parentCheckpoint.checkpointPath)).includes(Buffer.from("Ada")),
      ).toBe(false);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("reserves a branch generation before provisioning so concurrent create cannot delete the winner", async () => {
    const fixture = await createFixture();
    try {
      const attempts = await Promise.allSettled([
        createBranch(fixture, "preview-race"),
        createBranch(fixture, "preview-race"),
      ]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
      const branch = fixture.service.listBranches(fixture.parent)[0];
      expect(branch?.tenant.branchId).toBe("preview-race");
      expect(branch && existsSync(branch.databasePath)).toBe(true);
      const storage = openStorageAdapter({
        databasePath: branch?.databasePath ?? "",
        databaseDirectory: join(fixture.directory, "databases"),
      });
      storage.close();
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("promotes a validated migration with CAS, restore point and idempotent retry", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture);
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-add-email",
        actorId: "actor-admin",
        idempotencyKey: "migration-preview-0001",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN email TEXT",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-branch-0002",
      );

      const first = await fixture.service.promote(
        created.branch.tenant,
        artifact.hash,
        "promote-request-0001",
        "actor-admin",
        "correlation-branch-0003",
      );
      const retry = await fixture.service.promote(
        created.branch.tenant,
        artifact.hash,
        "promote-request-0001",
        "actor-admin",
        "correlation-branch-0004",
      );

      expect(first.status).toBe("applied");
      expect(retry.status).toBe("replayed");
      expect(retry.restorePoint).toEqual(first.restorePoint);
      expect(
        fixture.parentStorage.execute({ sql: "SELECT email FROM accounts ORDER BY id" }).rows,
      ).toEqual([{ email: null }]);
      const restorePointStorage = openStorageAdapter({
        databasePath: first.restorePoint.checkpointPath,
        databaseDirectory: join(fixture.directory, "checkpoints"),
      });
      try {
        expect(
          restorePointStorage.execute({
            sql: "SELECT name FROM pragma_table_xinfo('accounts') WHERE name = ?",
            parameters: ["email"],
          }).rows,
        ).toEqual([]);
      } finally {
        restorePointStorage.close();
      }
      expect(fixture.audits.filter((event) => event.action === "branch.promote")).toHaveLength(1);

      await fixture.service.deleteBranch(
        created.branch.tenant,
        "actor-admin",
        "correlation-branch-delete-promoted",
      );
      expect(existsSync(first.restorePoint.checkpointPath)).toBe(false);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("rejects authorization expiring at the production mutation boundary", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-expiry-boundary");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-expiry-boundary",
        actorId: "actor-admin",
        idempotencyKey: "migration-expiry-boundary-key",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN expiry_boundary TEXT",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-expiry-boundary-apply",
      );

      await expect(
        fixture.service.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-expiry-boundary",
          "actor-admin",
          "correlation-expiry-boundary-promote",
          1_800_000_000_000,
        ),
      ).rejects.toEqual(
        new BranchError("BRANCH_FORBIDDEN", "Promotion authorization has expired."),
      );
      expect(
        fixture.parentStorage.execute({
          sql: "SELECT name FROM pragma_table_xinfo('accounts') WHERE name = ?",
          parameters: ["expiry_boundary"],
        }).rows,
      ).toEqual([]);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("rejects stale promotion targets without mutating production", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture);
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-add-email",
        actorId: "actor-admin",
        idempotencyKey: "migration-preview-0002",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN email TEXT",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-branch-0005",
      );
      fixture.parentStorage.execute({
        sql: "CREATE INDEX accounts_name_idx ON accounts (name)",
      });

      expect(
        fixture.service.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-request-0002",
          "actor-admin",
          "correlation-branch-0006",
        ),
      ).rejects.toEqual(
        new BranchError("BRANCH_CONFLICT", "Promotion target changed after branch creation."),
      );
      expect(
        fixture.parentStorage.execute({
          sql: "SELECT name FROM pragma_table_xinfo('accounts') WHERE name = ?",
          parameters: ["email"],
        }).rows,
      ).toEqual([]);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("does not claim promotion state for an unknown migration artifact", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-invalid-promotion");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-valid-after-invalid",
        actorId: "actor-admin",
        idempotencyKey: "migration-after-invalid",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN recovered TEXT",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-invalid-promotion-apply",
      );

      await expect(
        fixture.service.promote(
          created.branch.tenant,
          "a".repeat(64),
          "promote-invalid-artifact",
          "actor-admin",
          "correlation-invalid-promotion",
        ),
      ).rejects.toBeInstanceOf(BranchError);
      await expect(
        fixture.service.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-valid-after-invalid",
          "actor-admin",
          "correlation-valid-after-invalid",
        ),
      ).resolves.toMatchObject({ status: "applied" });
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("reconciles a migration committed before its catalog result after restart", async () => {
    const fixture = await createFixture();
    let activeService: BranchService | undefined = fixture.service;
    try {
      const created = await createBranch(fixture, "preview-migration-recovery");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-recovery-column",
        actorId: "actor-admin",
        idempotencyKey: "migration-recovery-key",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN recovered_after_restart TEXT",
      });
      branchStorage.close();
      await activeService.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-migration-recovery",
      );
      activeService.close();
      activeService = undefined;

      const catalog = new Database(join(fixture.directory, "catalog", "branches.sqlite"), {
        strict: true,
      });
      try {
        catalog
          .query<never, [string]>(
            "UPDATE branch_migration SET state = 'applying', result_schema_hash = NULL WHERE migration_hash = ?",
          )
          .run(artifact.hash);
        catalog.run("UPDATE branch SET state = 'migrating'");
      } finally {
        catalog.close(false);
      }

      activeService = await fixture.reopenService();
      const recovered = activeService.listBranches(fixture.parent)[0];
      expect(recovered?.state).toBe("active");
      await expect(
        activeService.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-recovered-migration",
          "actor-admin",
          "correlation-promote-recovered",
        ),
      ).resolves.toMatchObject({ status: "applied" });
    } finally {
      activeService?.close();
      fixture.parentStorage.close();
    }
  });

  test("rolls back migration claim when allowlisted DDL fails before commit", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-failed-migration");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const expectedSchemaHash = buildSchemaManifest(branchStorage).hash;
      branchStorage.close();
      const invalid = createMigrationArtifact({
        id: "migration-missing-column",
        actorId: "actor-admin",
        idempotencyKey: "migration-missing-column-key",
        expectedSchemaHash,
        sql: "CREATE INDEX missing_column_idx ON accounts (missing_column)",
      });
      await expect(
        fixture.service.applyToBranch(
          created.branch.tenant,
          invalid,
          "actor-admin",
          "correlation-missing-column",
        ),
      ).rejects.toBeInstanceOf(BranchError);
      expect(fixture.service.listBranches(fixture.parent)[0]?.state).toBe("active");

      const valid = createMigrationArtifact({
        id: "migration-valid-column",
        actorId: "actor-admin",
        idempotencyKey: "migration-valid-column-key",
        expectedSchemaHash,
        sql: "ALTER TABLE accounts ADD COLUMN valid_after_failure TEXT",
      });
      await expect(
        fixture.service.applyToBranch(
          created.branch.tenant,
          valid,
          "actor-admin",
          "correlation-valid-after-failure",
        ),
      ).resolves.toMatchObject({ migrationHash: valid.hash });
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("reconciles production commit completed before promotion catalog commit", async () => {
    const fixture = await createFixture();
    let activeService: BranchService | undefined = fixture.service;
    try {
      const created = await createBranch(fixture, "preview-promotion-recovery");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-promotion-recovery",
        actorId: "actor-admin",
        idempotencyKey: "migration-promotion-recovery-key",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN promoted_before_restart TEXT",
      });
      branchStorage.close();
      await activeService.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-promotion-recovery-apply",
      );
      await activeService.promote(
        created.branch.tenant,
        artifact.hash,
        "promote-recovery-key",
        "actor-admin",
        "correlation-promotion-recovery",
      );
      activeService.close();
      activeService = undefined;

      const catalog = new Database(join(fixture.directory, "catalog", "branches.sqlite"), {
        strict: true,
      });
      try {
        catalog.run("UPDATE branch_promotion SET state = 'applying', result_schema_hash = NULL");
        catalog.run("UPDATE branch SET state = 'promoting', promoted_at = NULL");
      } finally {
        catalog.close(false);
      }

      activeService = await fixture.reopenService();
      expect(activeService.listBranches(fixture.parent)[0]?.state).toBe("promoted");
      await expect(
        activeService.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-recovery-key",
          "actor-admin",
          "correlation-promotion-recovery-retry",
        ),
      ).resolves.toMatchObject({ status: "replayed" });
    } finally {
      activeService?.close();
      fixture.parentStorage.close();
    }
  });

  test("returns branch to active when migration fails only against production data", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-production-conflict");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-unique-account-name",
        actorId: "actor-admin",
        idempotencyKey: "migration-unique-account-name-key",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "CREATE UNIQUE INDEX accounts_name_unique ON accounts (name)",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-unique-preview",
      );
      fixture.parentStorage.execute({
        sql: "INSERT INTO accounts (id, name) VALUES (?, ?)",
        parameters: [2, "Ada"],
      });

      await expect(
        fixture.service.promote(
          created.branch.tenant,
          artifact.hash,
          "promote-production-conflict",
          "actor-admin",
          "correlation-production-conflict",
        ),
      ).rejects.toBeInstanceOf(BranchError);
      expect(fixture.service.listBranches(fixture.parent)[0]?.state).toBe("active");
      await expect(
        fixture.service.deleteBranch(
          created.branch.tenant,
          "actor-admin",
          "correlation-delete-after-conflict",
        ),
      ).resolves.toBeUndefined();
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("does not let deletion race with an in-flight promotion state", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-promote-race");
      const branchStorage = openStorageAdapter({
        databasePath: created.branch.databasePath,
        databaseDirectory: join(fixture.directory, "databases"),
      });
      const artifact = createMigrationArtifact({
        id: "migration-race-column",
        actorId: "actor-admin",
        idempotencyKey: "migration-preview-race",
        expectedSchemaHash: buildSchemaManifest(branchStorage).hash,
        sql: "ALTER TABLE accounts ADD COLUMN race_value TEXT",
      });
      branchStorage.close();
      await fixture.service.applyToBranch(
        created.branch.tenant,
        artifact,
        "actor-admin",
        "correlation-branch-race-apply",
      );

      const promotion = fixture.service.promote(
        created.branch.tenant,
        artifact.hash,
        "promote-request-race",
        "actor-admin",
        "correlation-branch-race-promote",
      );
      const [promotionResult, deletionResult] = await Promise.allSettled([
        promotion,
        fixture.service.deleteBranch(
          created.branch.tenant,
          "actor-admin",
          "correlation-branch-race-delete",
        ),
      ]);
      expect(promotionResult.status).toBe("rejected");
      expect(deletionResult.status).toBe("fulfilled");
      expect(
        fixture.parentStorage.execute({
          sql: "SELECT name FROM pragma_table_xinfo('accounts') WHERE name = ?",
          parameters: ["race_value"],
        }).rows,
      ).toEqual([]);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("claims expired previews once during cleanup races and never deletes production", async () => {
    const fixture = await createFixture();
    try {
      const created = await createBranch(fixture, "preview-expired", 1, 60);
      fixture.setNow(created.branch.expiresAt + 1);
      const [first, second] = await Promise.all([
        fixture.service.cleanupExpired(),
        fixture.service.cleanupExpired(),
      ]);

      expect(first.length + second.length).toBe(1);
      expect(fixture.service.listBranches(fixture.parent)).toEqual([]);
      expect(existsSync(created.branch.databasePath)).toBe(false);
      expect(fixture.revoked).toHaveLength(1);
      expect(fixture.parentStorage.execute({ sql: "SELECT name FROM accounts" }).rows).toEqual([
        { name: "Ada" },
      ]);
      expect(existsSync(join(fixture.directory, "databases", "production.sqlite"))).toBe(true);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("API fails closed for missing capability and cross-organization branch requests", async () => {
    const fixture = await createFixture();
    try {
      const correlationId = parseCorrelationId("018f2a11-2c8d-7cb4-9d46-1f1297e55cb8");
      const withoutCapability = createTenantContext({
        tenant: fixture.parent,
        actor: { kind: "user", id: "actor-admin" },
        capabilities: [],
        correlationId,
      });
      const requestBody = {
        tenant: {
          ...fixture.parent,
          organizationId: "org-other",
          environmentId: "preview",
          branchId: "preview-api",
          generation: 1,
        },
        ttlSeconds: 300,
        idempotencyKey: "create-preview-api",
      };
      const denied = await fixture.service.handleRequest(
        new Request("https://control.example.test/branches", {
          method: "POST",
          body: JSON.stringify(requestBody),
        }),
        withoutCapability,
      );
      expect(denied.status).toBe(403);

      const authorized = createTenantContext({
        tenant: fixture.parent,
        actor: { kind: "user", id: "actor-admin" },
        capabilities: [
          {
            id: "capability-branch-create",
            tenant: fixture.parent,
            actions: ["branch:create"],
            expiresAt: 1_800_000_060_000,
          },
        ],
        correlationId,
      });
      const crossTenant = await fixture.service.handleRequest(
        new Request("https://control.example.test/branches", {
          method: "POST",
          body: JSON.stringify(requestBody),
        }),
        authorized,
      );
      expect(crossTenant.status).toBe(403);
      expect(fixture.service.listBranches(fixture.parent)).toEqual([]);

      const validBody = {
        ...requestBody,
        tenant: {
          ...requestBody.tenant,
          organizationId: fixture.parent.organizationId,
          projectId: fixture.parent.projectId,
        },
        idempotencyKey: "create-preview-api-valid",
      };
      const created = await fixture.service.handleRequest(
        new Request("https://control.example.test/branches", {
          method: "POST",
          body: JSON.stringify(validBody),
        }),
        authorized,
      );
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const createdText = await created.text();
      expect(createdText).not.toContain("databasePath");
      expect(createdText).not.toContain("checkpointPath");
      expect(createdText).not.toContain("credentialId");

      const wrongParent = tenant("main", 1, "staging");
      const wrongParentContext = createTenantContext({
        tenant: wrongParent,
        actor: { kind: "user", id: "actor-admin" },
        capabilities: [
          {
            id: "capability-branch-delete",
            tenant: wrongParent,
            actions: ["branch:delete"],
            expiresAt: 1_800_000_060_000,
          },
        ],
        correlationId,
      });
      const deniedOtherParent = await fixture.service.handleRequest(
        new Request(
          "https://control.example.test/branches/preview-api?environmentId=preview&generation=1",
          { method: "DELETE" },
        ),
        wrongParentContext,
      );
      expect(deniedOtherParent.status).toBe(403);
    } finally {
      fixture.service.close();
      fixture.parentStorage.close();
    }
  });

  test("records upstream engine capabilities without claiming an unimplemented managed adapter", () => {
    expect(
      engineCapabilities.find((capability) => capability.engine === "local-bun-sqlite")?.status,
    ).toBe("implemented");
    expect(
      engineCapabilities.find((capability) => capability.engine === "turso-cloud")?.status,
    ).toBe("verified_upstream");
  });
});

function tenantScope(value: TenantIdentity): string {
  return [
    value.organizationId,
    value.projectId,
    value.environmentId,
    value.branchId,
    value.generation,
  ].join(":");
}

function authPath(directory: string, value: TenantIdentity): string {
  return join(
    directory,
    value.organizationId,
    value.projectId,
    value.environmentId,
    value.branchId,
    String(value.generation),
    "preview",
    "auth.sqlite",
  );
}
