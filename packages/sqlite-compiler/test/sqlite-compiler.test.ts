import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMutationAst, parseQuery, type QueryAst } from "@mekka/query-ast";
import { buildSchemaManifest, type SchemaManifest } from "@mekka/schema-manifest";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import {
  SQLiteCompilerError,
  compileMutation,
  compileSelect,
  compileSelectCount,
  sqliteCompilerFormatVersion,
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
  const directory = await mkdtemp(join(tmpdir(), "mekka-sqlite-compiler-"));
  temporaryDirectories.push(directory);
  return openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "test.sqlite"),
  });
}

const manifest: SchemaManifest = {
  formatVersion: 1,
  schemaVersion: 1,
  hash: "test-manifest",
  tables: [
    {
      name: 'people"; DROP TABLE people; --',
      columns: [
        {
          name: "id",
          type: "INTEGER",
          notNull: true,
          defaultValue: null,
          primaryKeyPosition: 1,
          hidden: "none",
        },
        {
          name: "name",
          type: "TEXT",
          notNull: false,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: "none",
        },
        {
          name: "age",
          type: "INTEGER",
          notNull: false,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: "none",
        },
        {
          name: "private_score",
          type: "INTEGER",
          notNull: false,
          defaultValue: null,
          primaryKeyPosition: 0,
          hidden: "hidden",
        },
      ],
      foreignKeys: [],
      indexes: [],
    },
  ],
};

describe("SQLite SELECT compiler", () => {
  test("compiles insert, update, delete and primary-key upsert with bound values", () => {
    const table = 'people"; DROP TABLE people; --';

    expect(
      compileMutation(
        manifest,
        createMutationAst(manifest, "insert", table, { id: 1, name: "Ada" }),
      ),
    ).toMatchObject({
      sql: 'INSERT INTO "people""; DROP TABLE people; --" ("id", "name") VALUES (?, ?) RETURNING *',
      parameters: [1, "Ada"],
    });
    expect(
      compileMutation(
        manifest,
        createMutationAst(manifest, "update", table, { name: "Grace" }, { id: 1 }),
      ),
    ).toMatchObject({
      sql: expect.stringContaining('SET "name" = ? WHERE "id" = ?'),
      parameters: ["Grace", 1],
    });
    expect(
      compileMutation(manifest, createMutationAst(manifest, "delete", table, {}, { id: 1 })),
    ).toMatchObject({ sql: expect.stringContaining("DELETE FROM"), parameters: [1] });
    expect(
      compileMutation(
        manifest,
        createMutationAst(manifest, "upsert", table, { id: 1, name: "Ada" }, { id: 1 }),
      ),
    ).toMatchObject({
      sql: expect.stringContaining('ON CONFLICT ("id") DO UPDATE SET "name" = excluded."name"'),
      parameters: [1, "Ada"],
    });
  });

  test("compiles the golden AST into quoted SQL and positional parameters", () => {
    const ast = parseQuery(
      manifest,
      'people"; DROP TABLE people; --',
      "select=id,name&age=gte.18&name=neq.&or=(id.in.(1,2),not.and(name.is.null,age.lt.65))&order=name.desc.nullslast,id.asc&limit=15&offset=30",
    );

    expect(compileSelect(manifest, ast)).toEqual({
      formatVersion: sqliteCompilerFormatVersion,
      sql: 'SELECT "id", "name" FROM "people""; DROP TABLE people; --" WHERE (("age" >= ?) AND ("name" <> ?) AND (("id" IN (?, ?)) OR NOT (("name" IS NULL) AND ("age" < ?)))) ORDER BY "name" DESC NULLS LAST, "id" ASC LIMIT ? OFFSET ?',
      parameters: ["18", "", "1", "2", "65", 15, 30],
      cost: {
        selectedColumns: 2,
        filterNodes: 5,
        booleanGroups: 3,
        orderTerms: 2,
        parameterCount: 7,
      },
    });
  });

  test("executes golden query semantics on a temporary SQLite database", async () => {
    const adapter = await createTemporaryAdapter();

    try {
      adapter.execute({
        sql: "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, active INTEGER)",
      });
      adapter.execute({
        sql: "INSERT INTO people (id, name, age, active) VALUES (?, ?, ?, ?)",
        parameters: [1, "Ada", 34, 1],
      });
      adapter.execute({
        sql: "INSERT INTO people (id, name, age, active) VALUES (?, ?, ?, ?)",
        parameters: [2, "Bea", 16, 0],
      });
      adapter.execute({
        sql: "INSERT INTO people (id, name, age, active) VALUES (?, ?, ?, ?)",
        parameters: [3, null, 40, 1],
      });
      adapter.execute({
        sql: "INSERT INTO people (id, name, age, active) VALUES (?, ?, ?, ?)",
        parameters: [4, "Dee", 65, null],
      });
      const databaseManifest = buildSchemaManifest(adapter);
      const compiled = compileSelect(
        databaseManifest,
        parseQuery(
          databaseManifest,
          "people",
          "select=id,name&age=gte.18&or=(active.is.true,name.is.null)&order=id.desc&limit=2&offset=0",
        ),
      );

      expect(compiled.sql).toBe(
        'SELECT "id", "name" FROM "people" WHERE (("age" >= ?) AND (("active" IS TRUE) OR ("name" IS NULL))) ORDER BY "id" DESC LIMIT ?',
      );
      expect(adapter.execute(compiled).rows).toEqual([
        { id: 3, name: null },
        { id: 1, name: "Ada" },
      ]);
    } finally {
      adapter.close();
    }
  });

  test("binds injection corpus as values and never emits it in SQL", () => {
    const injection = "x' OR 1=1; DROP TABLE people; --";
    const compiled = compileSelect(
      manifest,
      parseQuery(
        manifest,
        'people"; DROP TABLE people; --',
        `name=eq.${encodeURIComponent(injection)}&id=in.(1,2,3)`,
      ),
    );

    expect(compiled.sql).not.toContain(injection);
    expect(compiled.parameters).toEqual([injection, "1", "2", "3"]);
  });

  test("fails closed for forged identifiers, malformed AST and bounded compiler inputs", () => {
    const safe = parseQuery(manifest, 'people"; DROP TABLE people; --', "id=in.(1,2)");
    const unknownColumn = {
      ...safe,
      select: { kind: "columns" as const, columns: ["private_score"] },
    };
    const unknownTable = { ...safe, table: "other" };
    const malformed = {
      ...safe,
      order: [{ column: "id", direction: "sideways", nulls: null }],
    } as unknown as QueryAst;

    expect(() => compileSelect(manifest, unknownColumn)).toThrow(
      new SQLiteCompilerError(
        "SQLITE_COMPILER_VALIDATION",
        'Column "private_score" is not exposed by the schema manifest.',
      ),
    );
    expect(() => compileSelect(manifest, unknownTable)).toThrow(
      new SQLiteCompilerError(
        "SQLITE_COMPILER_VALIDATION",
        'Table "other" is not exposed by the schema manifest.',
      ),
    );
    expect(() => compileSelect(manifest, malformed)).toThrow(
      new SQLiteCompilerError("SQLITE_COMPILER_MALFORMED", "Order direction must be asc or desc."),
    );
    expect(() => compileSelect(manifest, safe, { limits: { maxListSize: 1 } })).toThrow(
      new SQLiteCompilerError("SQLITE_COMPILER_LIMIT", "in list exceeds the list limit of 1."),
    );
    expect(() => compileSelect(manifest, safe, { limits: { maxParameters: 1 } })).toThrow(
      new SQLiteCompilerError("SQLITE_COMPILER_LIMIT", "Query uses more than 1 bound parameters."),
    );
  });

  test("uses a bound unlimited limit when offset is present without limit", () => {
    const compiled = compileSelect(
      manifest,
      parseQuery(manifest, 'people"; DROP TABLE people; --', "offset=5"),
    );

    expect(compiled.sql).toBe(
      'SELECT "id", "name", "age" FROM "people""; DROP TABLE people; --" LIMIT ? OFFSET ?',
    );
    expect(compiled.parameters).toEqual([-1, 5]);
  });

  test("compiles a count projection without client ordering or pagination", () => {
    const compiled = compileSelectCount(
      manifest,
      parseQuery(manifest, 'people"; DROP TABLE people; --', "id=in.(1,2)&order=id.desc&limit=1"),
    );

    expect(compiled.sql).toBe(
      'SELECT COUNT(*) AS count FROM "people""; DROP TABLE people; --" WHERE (("id" IN (?, ?)))',
    );
    expect(compiled.parameters).toEqual(["1", "2"]);
  });
});
