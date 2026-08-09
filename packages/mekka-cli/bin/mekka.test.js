import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isMekkaRepository,
  missingBunMessage,
  parseArguments,
  resolveTargetDirectory,
} from "./mekka.js";

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

test("prints a complete Windows Bun installation path", () => {
  const message = missingBunMessage("win32");
  assert.match(message, /Bun is not installed/);
  assert.match(message, /powershell -c "irm bun\.sh\/install\.ps1 \| iex"/);
  assert.match(message, /npx mekka/);
});

test("prints a complete macOS and Linux Bun installation path", () => {
  const message = missingBunMessage("linux");
  assert.match(message, /curl -fsSL https:\/\/bun\.sh\/install \| bash/);
  assert.match(message, /Bun 1\.3\.14 or newer/);
});

test("exits safely before setup when Bun is missing", () => {
  const directory = join(tmpdir(), `mekka-cli-path-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "mekka.js"), "--no-start"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory,
          Path: directory,
          PATHEXT: ".CMD;.EXE;.BAT",
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bun is not installed/);
    assert.match(result.stderr, /Then open a new terminal and run:\s+npx mekka/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
