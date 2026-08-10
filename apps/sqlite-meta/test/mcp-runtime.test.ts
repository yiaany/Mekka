import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApprovalStore } from "../src/mcp-runtime";

const temporaryDirectories: string[] = [];
const tenant = {
  organizationId: "org-local",
  projectId: "local",
  environmentId: "env-local",
  branchId: "agent-preview-one",
  generation: 1,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sqlite-meta MCP approval ownership", () => {
  test("lists, blocks, and decides approvals only for their actor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-mcp-approvals-"));
    temporaryDirectories.push(directory);
    const approvals = openApprovalStore(join(directory, "approvals.sqlite"));
    try {
      const alice = await approvals.hook.request({
        tenant,
        proposalId: "proposal-alice",
        artifactHash: "artifact-alice",
        parentSchemaHash: "parent-alice",
        previewSchemaHash: "preview-alice",
        actorId: "user-alice",
        sql: "ALTER TABLE notes ADD COLUMN title TEXT",
        destructive: false,
      });
      await approvals.hook.request({
        tenant: { ...tenant, branchId: "agent-preview-two" },
        proposalId: "proposal-bob",
        artifactHash: "artifact-bob",
        parentSchemaHash: "parent-bob",
        previewSchemaHash: "preview-bob",
        actorId: "user-bob",
        sql: "ALTER TABLE notes ADD COLUMN body TEXT",
        destructive: false,
      });

      expect(approvals.list("user-alice").map((approval) => approval.actorId)).toEqual([
        "user-alice",
      ]);
      expect(approvals.findBlocking("user-alice")?.proposalId).toBe("proposal-alice");
      expect(() => approvals.decide(alice.approvalId, "user-bob", "approved")).toThrow(
        "missing, expired, or already decided",
      );
      expect(approvals.decide(alice.approvalId, "user-alice", "approved").approval.state).toBe(
        "approved",
      );
      expect(approvals.findBlocking("user-alice")?.state).toBe("approved");
    } finally {
      approvals.close();
    }
  });
});
