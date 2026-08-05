import { describe, expect, test } from "bun:test";
import type { SchemaManifest } from "@mekka/schema-manifest";
import { QueryAstError, parseQuery, queryAstFormatVersion } from "../src/index";

const manifest: SchemaManifest = {
  formatVersion: 1,
  schemaVersion: 1,
  hash: "test-manifest",
  tables: [
    {
      name: "people",
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

describe("PostgREST query subset", () => {
  test("builds a deterministic typed AST for reference filters, select, order and pagination", () => {
    const query =
      "select=id,name&age=gte.18&name=neq.&or=(id.in.(1,2),not.and(name.is.null,age.lt.65))&order=name.desc.nullslast,id.asc&limit=15&offset=30";

    expect(parseQuery(manifest, "people", query)).toEqual({
      formatVersion: queryAstFormatVersion,
      table: "people",
      select: { kind: "columns", columns: ["id", "name"] },
      filter: {
        kind: "group",
        operator: "and",
        negated: false,
        terms: [
          { kind: "filter", column: "age", operator: "gte", negated: false, value: "18" },
          { kind: "filter", column: "name", operator: "neq", negated: false, value: "" },
          {
            kind: "group",
            operator: "or",
            negated: false,
            terms: [
              { kind: "filter", column: "id", operator: "in", negated: false, value: ["1", "2"] },
              {
                kind: "group",
                operator: "and",
                negated: true,
                terms: [
                  { kind: "filter", column: "name", operator: "is", negated: false, value: "null" },
                  { kind: "filter", column: "age", operator: "lt", negated: false, value: "65" },
                ],
              },
            ],
          },
        ],
      },
      order: [
        { column: "name", direction: "desc", nulls: "last" },
        { column: "id", direction: "asc", nulls: null },
      ],
      limit: 15,
      offset: 30,
    });
  });

  test("uses URL decoding and preserves quoted in values as data", () => {
    expect(
      parseQuery(
        manifest,
        "people",
        "name=in.(%22Hebdon%2CJohn%22,%22Quote%3A%5C%22%22)&age=eq.18+",
      ),
    ).toMatchObject({
      select: { kind: "all" },
      filter: {
        terms: [
          {
            column: "name",
            operator: "in",
            value: ["Hebdon,John", 'Quote:"'],
          },
          { column: "age", operator: "eq", value: "18 " },
        ],
      },
      limit: null,
      offset: 0,
    });
  });

  test("fails closed for unknown tables, columns and operators", () => {
    expect(() => parseQuery(manifest, "unknown", "id=eq.1")).toThrow(
      new QueryAstError(
        "QUERY_AST_VALIDATION",
        'Table "unknown" is not exposed by the schema manifest.',
      ),
    );
    expect(() => parseQuery(manifest, "people", "private_score=eq.1")).toThrow(
      new QueryAstError(
        "QUERY_AST_VALIDATION",
        'Column "private_score" is not exposed by the schema manifest.',
      ),
    );
    expect(() => parseQuery(manifest, "people", "name=like.*a*")).toThrow(
      new QueryAstError("QUERY_AST_UNSUPPORTED", 'Filter operator "like" is not supported.'),
    );
  });

  test("rejects malformed input and unsupported embedding instead of guessing", () => {
    expect(() => parseQuery(manifest, "people", "name=%E0%A4%A")).toThrow(
      new QueryAstError("QUERY_AST_MALFORMED", "Query contains invalid percent encoding."),
    );
    expect(() => parseQuery(manifest, "people", "or=()")).toThrow(
      new QueryAstError(
        "QUERY_AST_MALFORMED",
        "Boolean groups must contain at least one condition.",
      ),
    );
    expect(() => parseQuery(manifest, "people", "select=people(id)")).toThrow(
      new QueryAstError(
        "QUERY_AST_UNSUPPORTED",
        "Nested selects, aliases and embedding are not supported.",
      ),
    );
    expect(() => parseQuery(manifest, "people", "child.name=eq.value")).toThrow(
      new QueryAstError(
        "QUERY_AST_UNSUPPORTED",
        "Embedded resource query parameters are not supported.",
      ),
    );
  });

  test("bounds decoded length, nested groups, AST nodes and list sizes", () => {
    expect(() =>
      parseQuery(manifest, "people", "name=eq.abcdef", { limits: { maxDecodedLength: 5 } }),
    ).toThrow(new QueryAstError("QUERY_AST_LIMIT", "Decoded query length exceeds 5 characters."));
    expect(() =>
      parseQuery(manifest, "people", "or=(and(id.eq.1))", { limits: { maxDepth: 1 } }),
    ).toThrow(new QueryAstError("QUERY_AST_LIMIT", "Boolean group depth exceeds 1."));
    expect(() =>
      parseQuery(manifest, "people", "id=in.(1,2,3)", { limits: { maxListSize: 2 } }),
    ).toThrow(new QueryAstError("QUERY_AST_LIMIT", "in list exceeds the list limit of 2."));
    expect(() =>
      parseQuery(manifest, "people", "id=eq.1&age=eq.2", { limits: { maxNodes: 1 } }),
    ).toThrow(new QueryAstError("QUERY_AST_LIMIT", "Query AST exceeds the node limit of 1."));
  });

  test("terminates for malformed fuzz corpus", () => {
    const corpus = [
      "or=(id.eq.1",
      "or=(id.in.(1,2),)",
      "and=(not.xor(id.eq.1))",
      'id=in.("unterminated)',
      "id=in.(,,,,)",
      "id=eq.",
      "limit=-1",
      "offset=1.5",
      "order=id.desc.nullslast.extra",
      `or=(${"and(".repeat(20)}id.eq.1${")".repeat(20)})`,
    ];

    for (const input of corpus) {
      try {
        parseQuery(manifest, "people", input);
      } catch (error) {
        expect(error).toBeInstanceOf(QueryAstError);
      }
    }
  });
});
