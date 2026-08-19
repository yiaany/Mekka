import { createTenantContext, parseTenantIdentity } from "../packages/protocol/src/index";
import { openLibsqlEngine } from "../packages/engine-core/src/index";
import { openStorageAdapter } from "../packages/storage-core/src/index";
import { policyFormatVersion } from "../packages/policy-engine/src/index";
import { mcpCapabilityAction, startMcpStdio } from "../apps/mcp/src/index";

const tenant = parseTenantIdentity({
  organizationId: "org-opencode-smoke",
  projectId: "project-opencode-smoke",
  environmentId: "env-opencode-smoke",
  branchId: "branch-main",
  generation: 1,
});
const localStorage =
  process.env.MEKKA_DATA_ENGINE === "libsql-remote"
    ? undefined
    : openStorageAdapter({ databasePath: ":memory:" });
const storage =
  process.env.MEKKA_DATA_ENGINE === "libsql-remote"
    ? openLibsqlEngine({
        url: process.env.MEKKA_LIBSQL_URL ?? "",
        tokenReference: process.env.MEKKA_LIBSQL_TOKEN_ENV ?? "MEKKA_LIBSQL_TOKEN",
        allowLocalhost: process.env.MEKKA_LOCAL_DEV === "1",
      })
    : localStorage;
if (storage === undefined) throw new Error("MCP storage could not be initialized.");
if (localStorage !== undefined) {
  localStorage.execute({
    sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL)",
  });
  localStorage.execute({
    sql: "INSERT INTO notes (title) VALUES (?)",
    parameters: ["MCP is connected"],
  });
}

const context = createTenantContext({
  tenant,
  actor: { kind: "agent", id: "opencode-smoke" },
  capabilities: [
    {
      id: "opencode-smoke-read",
      tenant,
      actions: [mcpCapabilityAction],
      expiresAt: Number.MAX_SAFE_INTEGER,
    },
  ],
  correlationId: "00000000-0000-4000-8000-000000000001",
});

await startMcpStdio(context, {
  resolveProject: () => ({
    tenant,
    storage,
    policies: Object.freeze({ formatVersion: policyFormatVersion, tables: Object.freeze([]) }),
  }),
  listLogs: () => Object.freeze([]),
});

process.once("exit", () => {
  void storage.close();
});
