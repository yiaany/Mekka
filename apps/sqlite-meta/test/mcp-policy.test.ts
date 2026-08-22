import { describe, expect, test } from "bun:test";
import { createSelfHostedMcpReadPolicy } from "../src/mcp-policy";

describe("self-hosted MCP read policy", () => {
  test("allows only public manifest columns through an explicit select rule", () => {
    const policy = createSelfHostedMcpReadPolicy({
      formatVersion: 1,
      schemaVersion: 1,
      hash: "a".repeat(64),
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
              name: "generated",
              type: "TEXT",
              notNull: false,
              defaultValue: null,
              primaryKeyPosition: 0,
              hidden: "generated_stored",
            },
          ],
          foreignKeys: [],
          indexes: [],
        },
      ],
    });

    expect(policy.tables).toEqual([
      {
        table: "notes",
        rules: [
          {
            name: "self-hosted-agent-row-read",
            action: "select",
            fields: { allow: ["id"], deny: [] },
          },
        ],
      },
    ]);
  });
});
