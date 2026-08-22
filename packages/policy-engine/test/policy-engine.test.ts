import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantContext, type TenantContext } from "@mekka/protocol";
import { parseQuery } from "@mekka/query-ast";
import { buildSchemaManifest, type SchemaManifest } from "@mekka/schema-manifest";
import { compileSelect } from "@mekka/sqlite-compiler";
import { openStorageAdapter, type StorageAdapter } from "@mekka/storage-core";
import {
  PolicyError,
  policyFormatVersion,
  rewritePolicyQuery,
  simulatePolicy,
  type PolicyDocument,
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
  const directory = await mkdtemp(join(tmpdir(), "mekka-policy-engine-"));
  temporaryDirectories.push(directory);
  return openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "test.sqlite"),
  });
}

function context(actorId: string): TenantContext {
  return createTenantContext({
    tenant: {
      organizationId: "org-main",
      projectId: "project-main",
      environmentId: "environment-main",
      branchId: "branch-main",
      generation: 1,
    },
    actor: { kind: "user", id: actorId },
    capabilities: [],
    correlationId: "018e6c28-0000-7000-8000-000000000001",
  });
}

const document: PolicyDocument = {
  formatVersion: policyFormatVersion,
  tables: [
    {
      table: "notes",
      rules: [
        {
          name: "owner-select",
          action: "select",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["id", "body"], deny: [] },
        },
        {
          name: "owner-insert",
          action: "insert",
          check: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["owner_id", "body"], deny: ["id"] },
        },
        {
          name: "owner-update",
          action: "update",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          check: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
          fields: { allow: ["body"], deny: ["id", "owner_id"] },
        },
        {
          name: "owner-delete",
          action: "delete",
          using: {
            kind: "comparison",
            column: "owner_id",
            operator: "eq",
            value: { kind: "actor_id" },
          },
        },
      ],
    },
  ],
};

describe("policy engine v1", () => {
  test("denies missing policies and fields by default", () => {
    const manifest = notesManifest();

    expect(
      simulatePolicy(
        manifest,
        { formatVersion: policyFormatVersion, tables: [] },
        {
          context: context("alice"),
          action: "select",
          table: "notes",
          row: { id: 1, owner_id: "alice", body: "safe", private_note: "secret" },
          fields: ["id"],
        },
      ),
    ).toEqual({ allowed: false, allowedFields: [], matchedRules: [] });
    expect(() =>
      rewritePolicyQuery(
        manifest,
        { formatVersion: policyFormatVersion, tables: [] },
        context("alice"),
        "select",
        parseQuery(manifest, "notes", "select=id"),
      ),
    ).toThrow(new PolicyError("POLICY_FORBIDDEN", 'No select policy exists for table "notes".'));
    expect(
      simulatePolicy(manifest, document, {
        context: context("alice"),
        action: "select",
        table: "notes",
        row: { id: 1, owner_id: "alice", body: "safe", private_note: "secret" },
        fields: ["owner_id"],
      }),
    ).toMatchObject({ allowed: false, allowedFields: [], matchedRules: ["owner-select"] });
  });

  test("supports an explicit unconditional select policy without weakening missing-policy denial", () => {
    const manifest = notesManifest();
    const publicRead: PolicyDocument = {
      formatVersion: policyFormatVersion,
      tables: [
        {
          table: "notes",
          rules: [
            {
              name: "public-read",
              action: "select",
              fields: { allow: ["id", "body"], deny: [] },
            },
          ],
        },
      ],
    };
    const ast = parseQuery(manifest, "notes", "select=id,body&id=gte.1&order=id.asc&limit=2");
    const rewritten = rewritePolicyQuery(manifest, publicRead, context("alice"), "select", ast);

    expect(rewritten.ast).toEqual(ast);
    expect(rewritten.allowedFields).toEqual(["id", "body"]);
    expect(rewritten.matchedRules).toEqual(["public-read"]);
  });

  test("runtime simulator and query rewrite enforce the same select decision", async () => {
    const adapter = await createTemporaryAdapter();

    try {
      adapter.execute({
        sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL, private_note TEXT)",
      });
      adapter.execute({
        sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
        parameters: [1, "alice", "Alice note", "a-secret"],
      });
      adapter.execute({
        sql: "INSERT INTO notes (id, owner_id, body, private_note) VALUES (?, ?, ?, ?)",
        parameters: [2, "bob", "Bob note", "b-secret"],
      });
      const manifest = buildSchemaManifest(adapter);
      const rewritten = rewritePolicyQuery(
        manifest,
        document,
        context("alice"),
        "select",
        parseQuery(manifest, "notes", "select=id,body&order=id.asc"),
      );

      expect(adapter.execute(compileSelect(manifest, rewritten.ast)).rows).toEqual([
        { id: 1, body: "Alice note" },
      ]);
      const allFields = rewritePolicyQuery(
        manifest,
        document,
        context("alice"),
        "select",
        parseQuery(manifest, "notes", "select=*"),
      );
      expect(allFields.ast.select).toEqual({ kind: "columns", columns: ["id", "body"] });
      expect(
        simulatePolicy(manifest, document, {
          context: context("alice"),
          action: "select",
          table: "notes",
          row: { id: 1, owner_id: "alice", body: "Alice note", private_note: "a-secret" },
          fields: ["id", "body"],
        }).allowed,
      ).toBe(true);
      expect(
        simulatePolicy(manifest, document, {
          context: context("alice"),
          action: "select",
          table: "notes",
          row: { id: 2, owner_id: "bob", body: "Bob note", private_note: "b-secret" },
          fields: ["id", "body"],
        }).allowed,
      ).toBe(false);
    } finally {
      adapter.close();
    }
  });

  test("select star exposes only fields safe across every row-producing rule", () => {
    const manifest = notesManifest();
    const multiRule: PolicyDocument = {
      formatVersion: policyFormatVersion,
      tables: [
        {
          table: "notes",
          rules: [
            {
              name: "owner-public",
              action: "select",
              using: {
                kind: "comparison",
                column: "owner_id",
                operator: "eq",
                value: { kind: "actor_id" },
              },
              fields: { allow: ["id", "body"], deny: [] },
            },
            {
              name: "other-secret",
              action: "select",
              using: {
                kind: "comparison",
                column: "owner_id",
                operator: "neq",
                value: { kind: "actor_id" },
              },
              fields: { allow: ["id", "owner_id"], deny: [] },
            },
          ],
        },
      ],
    };

    const rewritten = rewritePolicyQuery(
      manifest,
      multiRule,
      context("alice"),
      "select",
      parseQuery(manifest, "notes", "select=*"),
    );
    expect(rewritten.ast.select).toEqual({ kind: "columns", columns: ["id"] });
    expect(() =>
      rewritePolicyQuery(
        manifest,
        multiRule,
        context("alice"),
        "select",
        parseQuery(manifest, "notes", "select=body"),
      ),
    ).toThrow(new PolicyError("POLICY_FORBIDDEN", "Selected fields are not permitted by policy."));
  });

  test("applies row and new-value checks across insert, update and delete", () => {
    const manifest = notesManifest();
    const alice = context("alice");
    const aliceRow = { id: 1, owner_id: "alice", body: "old", private_note: "secret" };
    const bobRow = { id: 2, owner_id: "bob", body: "old", private_note: "secret" };

    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "insert",
        table: "notes",
        input: { owner_id: "alice", body: "new" },
        fields: ["owner_id", "body"],
      }).allowed,
    ).toBe(true);
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "insert",
        table: "notes",
        input: { owner_id: "bob", body: "cross-tenant" },
        fields: ["owner_id", "body"],
      }).allowed,
    ).toBe(false);
    expect(() =>
      simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: aliceRow,
        input: { owner_id: "bob" },
        fields: [],
      }),
    ).toThrow(
      new PolicyError("POLICY_VALIDATION", "Mutation fields must exactly match the input keys."),
    );
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: aliceRow,
        input: { body: "changed" },
        fields: ["body"],
      }).allowed,
    ).toBe(true);
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: aliceRow,
        input: { owner_id: "bob" },
        fields: ["owner_id"],
      }).allowed,
    ).toBe(false);
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: bobRow,
        input: { body: "bypass" },
        fields: ["body"],
      }).allowed,
    ).toBe(false);
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "delete",
        table: "notes",
        row: aliceRow,
      }).allowed,
    ).toBe(true);
    expect(
      simulatePolicy(manifest, document, {
        context: alice,
        action: "delete",
        table: "notes",
        row: bobRow,
      }).allowed,
    ).toBe(false);
  });

  test("prevents cross-tenant CRUD changes in a temporary SQLite database", async () => {
    const adapter = await createTemporaryAdapter();

    try {
      adapter.execute({
        sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, body TEXT NOT NULL, private_note TEXT)",
      });
      adapter.execute({
        sql: "INSERT INTO notes (id, owner_id, body) VALUES (?, ?, ?)",
        parameters: [1, "alice", "original"],
      });
      adapter.execute({
        sql: "INSERT INTO notes (id, owner_id, body) VALUES (?, ?, ?)",
        parameters: [2, "bob", "protected"],
      });
      const manifest = buildSchemaManifest(adapter);
      const alice = context("alice");
      const aliceRow = { id: 1, owner_id: "alice", body: "original", private_note: null };
      const bobRow = { id: 2, owner_id: "bob", body: "protected", private_note: null };

      const insert = simulatePolicy(manifest, document, {
        context: alice,
        action: "insert",
        table: "notes",
        input: { owner_id: "alice", body: "created" },
        fields: ["owner_id", "body"],
      });
      if (insert.allowed) {
        adapter.execute({
          sql: "INSERT INTO notes (id, owner_id, body) VALUES (?, ?, ?)",
          parameters: [3, "alice", "created"],
        });
      }

      const update = simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: aliceRow,
        input: { body: "updated" },
        fields: ["body"],
      });
      if (update.allowed) {
        adapter.execute({
          sql: "UPDATE notes SET body = ? WHERE id = ?",
          parameters: ["updated", 1],
        });
      }

      const crossTenantUpdate = simulatePolicy(manifest, document, {
        context: alice,
        action: "update",
        table: "notes",
        row: bobRow,
        input: { body: "bypassed" },
        fields: ["body"],
      });
      expect(crossTenantUpdate.allowed).toBe(false);

      const crossTenantDelete = simulatePolicy(manifest, document, {
        context: alice,
        action: "delete",
        table: "notes",
        row: bobRow,
      });
      expect(crossTenantDelete.allowed).toBe(false);

      const deleteOwn = simulatePolicy(manifest, document, {
        context: alice,
        action: "delete",
        table: "notes",
        row: aliceRow,
      });
      if (deleteOwn.allowed) {
        adapter.execute({ sql: "DELETE FROM notes WHERE id = ?", parameters: [1] });
      }

      expect(
        adapter.execute({ sql: "SELECT id, owner_id, body FROM notes ORDER BY id" }).rows,
      ).toEqual([
        { id: 2, owner_id: "bob", body: "protected" },
        { id: 3, owner_id: "alice", body: "created" },
      ]);
    } finally {
      adapter.close();
    }
  });

  test("rejects policy bypass through forged hidden fields and invalid references", () => {
    const manifest = notesManifest();
    const malformed: PolicyDocument = {
      formatVersion: policyFormatVersion,
      tables: [
        {
          table: "notes",
          rules: [
            {
              name: "bad",
              action: "select",
              using: {
                kind: "comparison",
                column: "owner_id",
                operator: "eq",
                value: { kind: "actor_id" },
              },
              fields: { allow: ["private_note"], deny: [] },
            },
          ],
        },
      ],
    };

    expect(() =>
      simulatePolicy(manifest, malformed, {
        context: context("alice"),
        action: "select",
        table: "notes",
        row: { id: 1, owner_id: "alice", body: "safe", private_note: "secret" },
        fields: ["private_note"],
      }),
    ).toThrow(
      new PolicyError(
        "POLICY_VALIDATION",
        'Field "private_note" is not exposed by the schema manifest.',
      ),
    );
    expect(() =>
      rewritePolicyQuery(
        manifest,
        document,
        context("alice"),
        "select",
        parseQuery(manifest, "notes", "select=private_note"),
      ),
    ).toThrow();
  });
});

function notesManifest(): SchemaManifest {
  return {
    formatVersion: 1,
    schemaVersion: 1,
    hash: "notes-manifest",
    tables: [
      {
        name: "notes",
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
            name: "owner_id",
            type: "TEXT",
            notNull: true,
            defaultValue: null,
            primaryKeyPosition: 0,
            hidden: "none",
          },
          {
            name: "body",
            type: "TEXT",
            notNull: true,
            defaultValue: null,
            primaryKeyPosition: 0,
            hidden: "none",
          },
          {
            name: "private_note",
            type: "TEXT",
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
}
