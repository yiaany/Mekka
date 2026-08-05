import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchemaManifest } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import {
  MigrationError,
  applyMigration,
  createCheckpoint,
  createMigrationArtifact,
  restoreCheckpoint,
} from "../src/index";

const temporaryDirectories: string[] = [];

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

async function createFixture(): Promise<{
  adapter: StorageAdapter;
  directory: string;
  databasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "source.sqlite");
  const adapter = openStorageAdapter({ databaseDirectory: directory, databasePath });
  adapter.execute({ sql: "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" });
  adapter.execute({ sql: "INSERT INTO accounts (id, name) VALUES (?, ?)", parameters: [1, "Ada"] });
  return { adapter, directory, databasePath };
}

function artifact(
  storage: StorageAdapter,
  id = "migration-add-email",
): ReturnType<typeof createMigrationArtifact> {
  return createMigrationArtifact({
    id,
    actorId: "actor-admin",
    idempotencyKey: `key-${id}`,
    expectedSchemaHash: buildSchemaManifest(storage).hash,
    sql: "ALTER TABLE accounts ADD COLUMN email TEXT",
  });
}

describe("migration engine", () => {
  test("applies a hash-addressed migration once and replays its committed result safely", async () => {
    const fixture = await createFixture();
    try {
      const migration = artifact(fixture.adapter);
      const first = applyMigration(fixture.adapter, migration);
      const second = applyMigration(fixture.adapter, migration);

      expect(first.status).toBe("applied");
      expect(second).toEqual({ ...first, status: "replayed" });
      expect(fixture.adapter.execute({ sql: "SELECT email FROM accounts" }).rows).toEqual([
        { email: null },
      ]);
      expect(
        fixture.adapter.execute({ sql: "SELECT state, actor_id AS actorId FROM _mekka_migrations" })
          .rows,
      ).toEqual([{ state: "applied", actorId: "actor-admin" }]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("rejects stale schemas, conflicting identifiers and dangerous DDL without partial state", async () => {
    const fixture = await createFixture();
    try {
      const stale = artifact(fixture.adapter, "migration-stale");
      fixture.adapter.execute({ sql: "CREATE INDEX accounts_name_idx ON accounts (name)" });
      expect(() => applyMigration(fixture.adapter, stale)).toThrow(
        new MigrationError(
          "MIGRATION_CONFLICT",
          "Migration expected schema does not match target.",
        ),
      );
      expect(
        fixture.adapter.execute({ sql: "SELECT name FROM pragma_table_xinfo('accounts')" }).rows,
      ).not.toContainEqual({ name: "email" });

      const valid = artifact(fixture.adapter, "migration-unique-id");
      applyMigration(fixture.adapter, valid);
      const conflict = createMigrationArtifact({
        id: valid.id,
        actorId: "actor-admin",
        idempotencyKey: "key-conflict",
        expectedSchemaHash: valid.expectedSchemaHash,
        sql: "CREATE INDEX accounts_email_idx ON accounts (email)",
      });
      expect(() => applyMigration(fixture.adapter, conflict)).toThrow(
        new MigrationError(
          "MIGRATION_CONFLICT",
          "Migration identifier was reused with a different artifact.",
        ),
      );
      expect(() =>
        createMigrationArtifact({
          id: "migration-trigger",
          actorId: "actor-admin",
          idempotencyKey: "key-trigger",
          expectedSchemaHash: buildSchemaManifest(fixture.adapter).hash,
          sql: "CREATE TRIGGER unsafe AFTER INSERT ON accounts BEGIN SELECT 1 END",
        }),
      ).toThrow(new MigrationError("MIGRATION_FORBIDDEN", "Migration DDL is not allowlisted."));
    } finally {
      fixture.adapter.close();
    }
  });

  test("rolls back an interrupted apply and leaves no applying ledger entry", async () => {
    const fixture = await createFixture();
    try {
      const interrupted = createMigrationArtifact({
        id: "migration-interrupted",
        actorId: "actor-admin",
        idempotencyKey: "key-interrupted",
        expectedSchemaHash: buildSchemaManifest(fixture.adapter).hash,
        sql: "CREATE UNIQUE INDEX accounts_name_unique ON accounts (name)",
      });
      fixture.adapter.execute({
        sql: "INSERT INTO accounts (id, name) VALUES (?, ?)",
        parameters: [2, "Ada"],
      });

      expect(() => applyMigration(fixture.adapter, interrupted)).toThrow();
      expect(
        fixture.adapter.execute({
          sql: "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
          parameters: ["table", "_mekka_migrations"],
        }).rows,
      ).toEqual([]);
      expect(
        fixture.adapter.execute({
          sql: "SELECT name FROM pragma_index_list('accounts') WHERE name = ?",
          parameters: ["accounts_name_unique"],
        }).rows,
      ).toEqual([]);
    } finally {
      fixture.adapter.close();
    }
  });

  test("creates a VACUUM INTO checkpoint and restores verified schema and data without copying the live file", async () => {
    const fixture = await createFixture();
    let restored: StorageAdapter | undefined;
    try {
      const backup = createCheckpoint(fixture.adapter, {
        id: "checkpoint-accounts",
        checkpointPath: join(fixture.directory, "checkpoint.sqlite"),
        checkpointDirectory: fixture.directory,
      });
      fixture.adapter.execute({
        sql: "INSERT INTO accounts (id, name) VALUES (?, ?)",
        parameters: [2, "Grace"],
      });
      restored = restoreCheckpoint(backup, {
        destinationPath: join(fixture.directory, "restored.sqlite"),
        destinationDirectory: fixture.directory,
      });

      expect(restored.execute({ sql: "SELECT id, name FROM accounts ORDER BY id" }).rows).toEqual([
        { id: 1, name: "Ada" },
      ]);
      expect(buildSchemaManifest(restored).tables).toEqual(
        buildSchemaManifest(fixture.adapter).tables,
      );
      expect(() =>
        fixture.adapter.createCheckpoint({
          destinationPath: fixture.databasePath,
          destinationDirectory: fixture.directory,
        }),
      ).toThrow();
    } finally {
      restored?.close();
      fixture.adapter.close();
    }
  });
});
