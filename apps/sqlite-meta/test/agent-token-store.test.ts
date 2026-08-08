import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentTokenStore } from "../src/agent-token-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Agent Access token store", () => {
  test("persists hashed grants across instances without storing the bearer token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-agent-token-"));
    directories.push(directory);
    const path = join(directory, "agent-access.sqlite");
    const rawToken = "raw-agent-token-that-must-not-be-persisted";
    const tokenHash = "a".repeat(64);
    const verified = accessToken();
    const first = openAgentTokenStore(path);
    expect(first.issue(tokenHash, verified, 10_000)).toBe(true);
    first.close();

    const second = openAgentTokenStore(path);
    expect(second.verify(tokenHash, 9_999)).toEqual(verified);
    second.close();

    const database = new Database(path, { readonly: true });
    const serialized = JSON.stringify(
      database.query("SELECT * FROM _mekka_agent_access_token").all(),
    );
    database.close();
    expect(serialized).not.toContain(rawToken);
  });

  test("expires, revokes and replaces grants with bounded cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-agent-token-"));
    directories.push(directory);
    const store = openAgentTokenStore(join(directory, "agent-access.sqlite"));
    const verified = accessToken();
    const timestamp = Date.now();
    expect(store.issue("1".repeat(64), verified, 100)).toBe(true);
    expect(store.verify("1".repeat(64), 100)).toBeNull();
    expect(store.issue("2".repeat(64), verified, timestamp + 200)).toBe(true);
    expect(store.modeFor(verified.tokenId, verified.tenant, verified.userId)).toBe("read");
    const writeVerified = { ...verified, tokenId: "jwt-write" };
    expect(store.issue("3".repeat(64), writeVerified, timestamp + 300, "write")).toBe(true);
    expect(store.modeFor(writeVerified.tokenId, writeVerified.tenant, writeVerified.userId)).toBe(
      "write",
    );
    expect(store.verify("2".repeat(64), timestamp + 150)).toBeNull();
    expect(store.verify("3".repeat(64), timestamp + 150)).not.toBeNull();
    store.revokeSession(verified.sessionId);
    expect(store.verify("3".repeat(64), timestamp + 150)).toBeNull();
    store.close();
  });
});

function accessToken() {
  return Object.freeze({
    userId: "user-1",
    sessionId: "session-1",
    tokenId: "jwt-1",
    tenant: Object.freeze({
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "env-1",
      branchId: "branch-1",
      generation: 1,
    }),
    issuedAt: 1,
    expiresAt: 10,
  });
}
