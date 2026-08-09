import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { isMekkaRepository, parseArguments, resolveTargetDirectory } from "./mekka.js";

test("parses a target directory and startup flags", () => {
  assert.deepEqual(parseArguments(["my-app", "--no-start", "--no-install"]), {
    directory: "my-app",
    install: false,
    start: false,
    help: false,
    version: false,
  });
});

test("rejects unknown options and multiple directories", () => {
  assert.throws(() => parseArguments(["--wat"]), /Unknown option/);
  assert.throws(() => parseArguments(["one", "two"]), /at most one target directory/);
});

test("defaults to a mekka child directory outside a project", () => {
  assert.equal(resolveTargetDirectory("/workspace", null), resolve("/workspace", "mekka"));
});

test("uses the current directory inside a Mekka checkout", () => {
  const directory = join(tmpdir(), `mekka-cli-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ name: "mekka", scripts: { "dev:studio": "example" } }),
    );
    assert.equal(isMekkaRepository(directory), true);
    assert.equal(resolveTargetDirectory(directory, null), resolve(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
