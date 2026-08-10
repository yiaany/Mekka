import assert from "node:assert/strict";
import test from "node:test";

import { ensureCoreBuild } from "./ensure-core-build.mjs";

test("builds core outputs before a direct dev start", () => {
  const calls = [];
  ensureCoreBuild({
    env: { MEKKA_BUN_EXECUTABLE: "C:\\tools\\bun.exe" },
    platform: "win32",
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\tools\\bun.exe");
  assert.deepEqual(calls[0].args, ["run", "build:core"]);
  assert.equal(calls[0].options.shell, false);
});

test("skips the duplicate build after the CLI already built core", () => {
  ensureCoreBuild({
    env: { MEKKA_CORE_BUILT: "1" },
    spawnSyncImpl() {
      assert.fail("core build must not run twice");
    },
  });
});

test("fails closed when the core build fails", () => {
  assert.throws(
    () =>
      ensureCoreBuild({
        env: {},
        spawnSyncImpl: () => ({ status: 1 }),
      }),
    /core build failed/,
  );
});
