import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import {
  buildSchemaManifest,
  buildSchemaManifestAsync,
  createSchemaManifestCache,
  isReservedSchemaIdentifier,
  SchemaManifestError,
  schemaManifestFormatVersion,
} from "../src/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createTemporaryAdapter(): Promise<StorageAdapter> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-schema-manifest-"));
  temporaryDirectories.push(directory);

  return openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "test.sqlite"),
  });
}

describe("SQLite schema manifest", () => {
  test("recognizes reserved schema identifiers case-insensitively", () => {
    expect(isReservedSchemaIdentifier("sqlite_shadow")).toBe(true);
    expect(isReservedSchemaIdentifier("SQLITE_shadow")).toBe(true);
    expect(isReservedSchemaIdentifier("_mekka_ledger")).toBe(true);
    expect(isReservedSchemaIdentifier("_MEKKA_ledger")).toBe(true);
    expect(isReservedSchemaIdentifier("customer_notes")).toBe(false);
  });

  test("builds a deterministic golden manifest without runtime tables or data", async () => {
    const adapter = await createTemporaryAdapter();

    try {
      adapter.execute({
        sql: "CREATE TABLE _mekka_migrations (id TEXT PRIMARY KEY, secret TEXT NOT NULL)",
      });
      adapter.execute({
        sql: "INSERT INTO _mekka_migrations (id, secret) VALUES (?, ?)",
        parameters: ["migration-1", "must-not-appear"],
      });
      adapter.execute({
        sql: "CREATE TABLE authors (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)",
      });
      adapter.execute({
        sql: "CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE, title TEXT NOT NULL, slug TEXT NOT NULL, UNIQUE (author_id, slug))",
      });
      adapter.execute({ sql: "CREATE INDEX posts_title_desc ON posts (title DESC)" });

      const first = buildSchemaManifest(adapter);
      const second = buildSchemaManifest(adapter);
      const asynchronous = await buildSchemaManifestAsync({
        execute: async (statement) => adapter.execute(statement),
      });

      expect(second).toEqual(first);
      expect(asynchronous).toEqual(first);
      expect(first).toEqual({
        formatVersion: schemaManifestFormatVersion,
        schemaVersion: first.schemaVersion,
        hash: first.hash,
        tables: [
          {
            name: "authors",
            columns: [
              {
                name: "id",
                type: "INTEGER",
                notNull: false,
                defaultValue: null,
                primaryKeyPosition: 1,
                hidden: "none",
              },
              {
                name: "email",
                type: "TEXT",
                notNull: true,
                defaultValue: null,
                primaryKeyPosition: 0,
                hidden: "none",
              },
            ],
            foreignKeys: [],
            indexes: [
              {
                name: "sqlite_autoindex_authors_1",
                unique: true,
                origin: "unique_constraint",
                partial: false,
                columns: [
                  {
                    sequence: 0,
                    columnId: 1,
                    name: "email",
                    descending: false,
                    collation: "BINARY",
                    key: true,
                  },
                  {
                    sequence: 1,
                    columnId: -1,
                    name: null,
                    descending: false,
                    collation: "BINARY",
                    key: false,
                  },
                ],
              },
            ],
          },
          {
            name: "posts",
            columns: [
              {
                name: "id",
                type: "INTEGER",
                notNull: false,
                defaultValue: null,
                primaryKeyPosition: 1,
                hidden: "none",
              },
              {
                name: "author_id",
                type: "INTEGER",
                notNull: true,
                defaultValue: null,
                primaryKeyPosition: 0,
                hidden: "none",
              },
              {
                name: "title",
                type: "TEXT",
                notNull: true,
                defaultValue: null,
                primaryKeyPosition: 0,
                hidden: "none",
              },
              {
                name: "slug",
                type: "TEXT",
                notNull: true,
                defaultValue: null,
                primaryKeyPosition: 0,
                hidden: "none",
              },
            ],
            foreignKeys: [
              {
                id: 0,
                columns: ["author_id"],
                referencedTable: "authors",
                referencedColumns: ["id"],
                onUpdate: "NO ACTION",
                onDelete: "CASCADE",
                match: "NONE",
              },
            ],
            indexes: [
              {
                name: "posts_title_desc",
                unique: false,
                origin: "created",
                partial: false,
                columns: [
                  {
                    sequence: 0,
                    columnId: 2,
                    name: "title",
                    descending: true,
                    collation: "BINARY",
                    key: true,
                  },
                  {
                    sequence: 1,
                    columnId: -1,
                    name: null,
                    descending: false,
                    collation: "BINARY",
                    key: false,
                  },
                ],
              },
              {
                name: "sqlite_autoindex_posts_1",
                unique: true,
                origin: "unique_constraint",
                partial: false,
                columns: [
                  {
                    sequence: 0,
                    columnId: 1,
                    name: "author_id",
                    descending: false,
                    collation: "BINARY",
                    key: true,
                  },
                  {
                    sequence: 1,
                    columnId: 3,
                    name: "slug",
                    descending: false,
                    collation: "BINARY",
                    key: true,
                  },
                  {
                    sequence: 2,
                    columnId: -1,
                    name: null,
                    descending: false,
                    collation: "BINARY",
                    key: false,
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(first.tables.map((table) => table.name)).toEqual(["authors", "posts"]);
      expect(JSON.stringify(first)).not.toContain("must-not-appear");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.tables)).toBe(true);
    } finally {
      adapter.close();
    }
  });

  test("updates the cached manifest after DDL and supports explicit invalidation", async () => {
    const adapter = await createTemporaryAdapter();

    try {
      adapter.execute({ sql: "CREATE TABLE accounts (id INTEGER PRIMARY KEY)" });
      const cache = createSchemaManifestCache(adapter);
      const initial = cache.get();

      expect(cache.get()).toBe(initial);

      adapter.execute({ sql: "ALTER TABLE accounts ADD COLUMN email TEXT" });
      const changed = cache.get();

      expect(changed).not.toBe(initial);
      expect(changed.schemaVersion).toBeGreaterThan(initial.schemaVersion);
      expect(changed.hash).not.toBe(initial.hash);
      expect(changed.tables[0]?.columns.map((column) => column.name)).toEqual(["id", "email"]);

      cache.invalidate();
      expect(cache.get()).not.toBe(changed);
      expect(cache.get()).toEqual(changed);
    } finally {
      adapter.close();
    }
  });

  test("rejects malformed catalog values instead of returning an incomplete manifest", () => {
    expect(() =>
      buildSchemaManifest({
        execute: () => ({ rows: [{ sqliteVersion: "3.44.0" }], changes: 0, lastInsertRowid: 0 }),
      }),
    ).toThrow(
      new SchemaManifestError(
        "SCHEMA_MANIFEST_MALFORMED",
        "schema version must be a safe integer.",
      ),
    );
  });

  test("rejects SQLite versions without table_list support", () => {
    expect(() =>
      buildSchemaManifest({
        execute: () => ({ rows: [{ sqliteVersion: "3.36.0" }], changes: 0, lastInsertRowid: 0 }),
      }),
    ).toThrow(
      new SchemaManifestError(
        "SCHEMA_MANIFEST_ENGINE_UNSUPPORTED",
        "SQLite 3.36.0 does not support PRAGMA table_list; SQLite 3.37.0 or later is required.",
      ),
    );
  });
});
