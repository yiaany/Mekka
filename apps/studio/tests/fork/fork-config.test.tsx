import assert from "node:assert/strict";
import { IS_PLATFORM as IS_COMMON_PLATFORM } from "common";
import { test } from "vitest";

import {
  generateOtherRoutes,
  generateProductRoutes,
  generateSettingsRoutes,
  generateToolRoutes,
} from "@/components/layouts/Navigation/NavigationBar/NavigationBar.utils";
import { generateMekkaAuthMenu } from "@/components/layouts/AuthLayout/AuthLayout.utils";
import type { Project } from "@/data/projects/project-detail-query";
import { getEdgeFunctionServiceStatus } from "@/data/service-status/edge-functions-status-query";
import { requireEnvironmentVariable } from "@/lib/api/self-hosted/constants";
import { IS_PLATFORM } from "@/lib/constants";
import { STUDIO_BRAND, STUDIO_FEATURES } from "@/lib/fork-config";
import { isMekkaSupportedApiPath } from "@/lib/fork-api-guard";
import {
  getForkProjectRedirect,
  getForkRouteRedirect,
} from "@/lib/fork-routing";
import {
  createSqliteSqlEditorId,
  isSqliteSqlEditorId,
} from "@/lib/sqlite-sql-editor-routing";
import {
  getOrCreateSqliteSqlEditorSession,
  removeSqliteSqlEditorSession,
  resetSqliteSqlEditorSessions,
} from "@/state/sqlite-sql-editor";

const project = { status: "ACTIVE_HEALTHY" } as Project;

assert.equal(IS_PLATFORM, false);
assert.equal(IS_COMMON_PLATFORM, false);
assert.deepEqual(STUDIO_BRAND, { name: "Mekka", description: "Mekka Studio" });

assert.equal(STUDIO_FEATURES.tableEditor, true);
assert.equal(STUDIO_FEATURES.sqlEditor, true);
assert.equal(STUDIO_FEATURES.auth, true);
assert.deepEqual(
  generateToolRoutes("local", project).map(({ key }) => key),
  ["editor", "sql"],
);
assert.deepEqual(
  generateProductRoutes("local", project).map(({ key }) => key),
  ["auth"],
);
assert.deepEqual(
  generateMekkaAuthMenu("local").flatMap(({ items }) =>
    items.map(({ key }) => key),
  ),
  ["register", "users", "sign-in-up", "url-configuration", "email"],
);
assert.deepEqual(generateOtherRoutes("local", project), []);
assert.deepEqual(generateSettingsRoutes("local"), []);

const originalFetch = globalThis.fetch;
let isFetchCalled = false;
globalThis.fetch = (async () => {
  isFetchCalled = true;
  throw new Error("Unexpected external request");
}) as typeof fetch;

try {
  assert.deepEqual(await getEdgeFunctionServiceStatus(), { healthy: false });
  assert.equal(isFetchCalled, false);
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(getForkProjectRedirect("/project/local"), "/project/local/editor");
assert.equal(
  getForkProjectRedirect("/project/default/editor/42"),
  "/project/local/editor/42",
);
assert.equal(
  getForkProjectRedirect("/project/default/sql/query"),
  "/project/local/sql/new",
);
assert.equal(getForkProjectRedirect("/project/local/editor/42"), undefined);
assert.equal(
  getForkProjectRedirect("/project/local/sql/query"),
  "/project/local/sql/new",
);
assert.equal(
  getForkProjectRedirect("/project/local/sql/templates"),
  "/project/local/sql/new",
);
assert.equal(
  getForkProjectRedirect("/project/local/sql/sqlite-123e4567-e89b-42d3-a456-426614174000"),
  undefined,
);
assert.equal(
  getForkProjectRedirect("/project/default/sql/sqlite-123e4567-e89b-42d3-a456-426614174000"),
  "/project/local/sql/sqlite-123e4567-e89b-42d3-a456-426614174000",
);

const firstSqlEditorId = createSqliteSqlEditorId();
const secondSqlEditorId = createSqliteSqlEditorId();
assert.equal(isSqliteSqlEditorId(firstSqlEditorId), true);
assert.equal(isSqliteSqlEditorId("new"), false);
assert.notEqual(firstSqlEditorId, secondSqlEditorId);
resetSqliteSqlEditorSessions();
const firstSqlSession = getOrCreateSqliteSqlEditorSession(firstSqlEditorId);
const secondSqlSession = getOrCreateSqliteSqlEditorSession(secondSqlEditorId);
firstSqlSession.sql = "SELECT 1 AS first LIMIT 1";
secondSqlSession.sql = "SELECT 2 AS second LIMIT 1";
assert.equal(getOrCreateSqliteSqlEditorSession(firstSqlEditorId).sql, "SELECT 1 AS first LIMIT 1");
assert.equal(getOrCreateSqliteSqlEditorSession(secondSqlEditorId).sql, "SELECT 2 AS second LIMIT 1");
removeSqliteSqlEditorSession(firstSqlEditorId);
assert.equal(
  getOrCreateSqliteSqlEditorSession(firstSqlEditorId).sql,
  "SELECT 1 AS value LIMIT 1",
);
assert.equal(getForkProjectRedirect("/project/local/auth/users"), undefined);
assert.equal(
  getForkProjectRedirect("/project/local/auth/mfa"),
  "/project/local/auth/users",
);
assert.equal(
  getForkProjectRedirect("/project/local/auth/templates/password-reset"),
  undefined,
);
assert.equal(
  getForkProjectRedirect("/project/local/storage/files"),
  "/project/local/editor",
);
assert.equal(
  getForkProjectRedirect("/project/local/settings/general"),
  "/project/local/editor",
);
assert.equal(
  getForkProjectRedirect("/project/local/realtime/inspector"),
  "/project/local/editor",
);
assert.equal(
  getForkProjectRedirect("/project/_/storage/files"),
  "/project/local/editor",
);
assert.equal(getForkRouteRedirect("/sign-in"), undefined);
assert.equal(getForkRouteRedirect("/onboarding"), "/project/local/editor");
assert.equal(getForkRouteRedirect("/"), "/project/local/editor");
assert.equal(getForkRouteRedirect("/api/platform/projects"), undefined);
assert.equal(getForkRouteRedirect("/project/local/editor/42"), undefined);
assert.equal(
  getForkRouteRedirect("/project/local/storage/files"),
  "/project/local/editor",
);
assert.equal(getForkRouteRedirect("/account/me"), "/project/local/editor");
assert.equal(getForkRouteRedirect("/organizations"), "/project/local/editor");
assert.equal(
  isMekkaSupportedApiPath("/api/platform/sqlite-meta/local/tables"),
  true,
);
assert.equal(
  isMekkaSupportedApiPath("/api/platform/auth-admin/local/users"),
  true,
);
assert.equal(
  isMekkaSupportedApiPath("/api/platform/pg-meta/local/query"),
  false,
);
assert.equal(isMekkaSupportedApiPath("/api/platform/auth/local/users"), false);
assert.equal(
  isMekkaSupportedApiPath("/api/platform/projects/local/api-keys"),
  false,
);
assert.equal(isMekkaSupportedApiPath("/api/mcp"), false);
assert.throws(
  () => requireEnvironmentVariable("TEST_SECRET", undefined),
  /TEST_SECRET must be configured for Mekka Studio/,
);

console.log("Mekka Studio fork assertions passed");

test("fork configuration assertions completed", () => {});
