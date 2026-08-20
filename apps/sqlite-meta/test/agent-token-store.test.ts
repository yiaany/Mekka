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
    expect(
      store.issue(
        "4".repeat(64),
        { ...verified, tokenId: "jwt-rows" },
        timestamp + 300,
        "read",
        true,
      ),
    ).toBe(true);
    expect(store.rowDataAllowed("jwt-rows", verified.tenant, verified.userId)).toBeTrue();
    store.revokeSession(verified.sessionId);
    expect(store.verify("3".repeat(64), timestamp + 150)).toBeNull();
    store.close();
  });

  test("migrates existing grants with row-data access disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mekka-agent-token-"));
    directories.push(directory);
    const path = join(directory, "agent-access.sqlite");
    const database = new Database(path, { strict: true });
    database.run(`CREATE TABLE _mekka_agent_access_token (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, token_id TEXT NOT NULL,
      organization_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
      branch_id TEXT NOT NULL, generation INTEGER NOT NULL, issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'read'
    ) STRICT`);
    database.run(
      `INSERT INTO _mekka_agent_access_token VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "b".repeat(64),
        "user-1",
        "session-1",
        "legacy",
        "org-1",
        "project-1",
        "env-1",
        "branch-1",
        1,
        1,
        Date.now() + 60_000,
        "read",
      ],
    );
    database.close();
    const store = openAgentTokenStore(path);
    expect(store.rowDataAllowed("legacy", accessToken().tenant, "user-1")).toBeFalse();
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
