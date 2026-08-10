import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  cloneProject,
  compareVersions,
  ensureBunExecutable,
  installBun,
  isNpxInvocation,
  isMekkaRepository,
  missingBunMessage,
  parseArguments,
  resolveExecutable,
  resolveTargetDirectory,
  shouldStopBeforeBuild,
  shouldInstallDependencies,
} from "./mekka.js";

function tarArchive(entries) {
  const blocks = [];
  for (const { path, content = "", type = "0" } of entries) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function mekkaArchive(extraEntries = []) {
  return tarArchive([
    { path: "Mekka-main/", type: "5" },
    {
      path: "Mekka-main/package.json",
      content: JSON.stringify({
        name: "mekka-workspace",
        scripts: { "dev:studio": "example" },
        workspaces: ["apps/*", "packages/*"],
      }),
    },
    { path: "Mekka-main/README.md", content: "Mekka" },
    ...extraEntries,
  ]);
}

test("parses a target directory and startup flags", () => {
  assert.deepEqual(parseArguments(["my-app", "--no-start", "--no-install"]), {
    directory: "my-app",
    install: false,
    start: false,
    help: false,
    version: false,
  });
});

test("supports forcing dependency installation", () => {
  assert.equal(parseArguments(["--install"]).install, true);
  assert.equal(parseArguments([]).install, null);
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
      JSON.stringify({
        name: "mekka-workspace",
        scripts: { "dev:studio": "example" },
        workspaces: ["apps/*", "packages/*"],
      }),
    );
    assert.equal(isMekkaRepository(directory), true);
    assert.equal(resolveTargetDirectory(directory, null), resolve(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires the root name plus script and both workspace markers", () => {
  const directory = join(tmpdir(), `mekka-cli-marker-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  try {
    const packageJson = {
      name: "not-mekka-workspace",
      scripts: { "dev:studio": "example" },
      workspaces: ["apps/*", "packages/*"],
    };
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    assert.equal(isMekkaRepository(directory), false);
    packageJson.name = "mekka-workspace";
    packageJson.workspaces = ["packages/*"];
    writeFileSync(join(directory, "package.json"), JSON.stringify(packageJson));
    assert.equal(isMekkaRepository(directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prints a complete Windows Bun installation path", () => {
  const message = missingBunMessage("win32");
  assert.match(message, /Bun could not be installed/);
  assert.match(message, /powershell -c "irm bun\.sh\/install\.ps1 \| iex"/);
  assert.match(message, /npx mekka/);
});

test("prints a complete macOS and Linux Bun installation path", () => {
  const message = missingBunMessage("linux");
  assert.match(message, /curl -fsSL https:\/\/bun\.sh\/install \| bash/);
  assert.match(message, /Bun 1\.3\.14 or newer/);
});

test("uses the official Bun installer without interpolating environment values", () => {
  let invocation;
  installBun({
    platform: "win32",
    env: { UNTRUSTED: '"; Remove-Item C:\\' },
    spawnSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "irm bun.sh/install.ps1 | iex",
  ]);
  assert.equal(invocation.options.shell, false);
  assert.doesNotMatch(invocation.args.join(" "), /Remove-Item/);
});

test("compares Bun semantic versions and detects npx specifically", () => {
  assert.ok(compareVersions("1.3.14", "1.3.14") === 0);
  assert.ok(compareVersions("1.3.13", "1.3.14") < 0);
  assert.ok(compareVersions("1.4.0", "1.3.14") > 0);
  assert.equal(compareVersions("development", "1.3.14"), null);
  assert.equal(
    isNpxInvocation({
      npm_command: "exec",
      npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
    }),
    true,
  );
  assert.equal(isNpxInvocation({ npm_command: "run-script", npm_execpath: "npm-cli.js" }), false);
});

test("upgrades an old Bun when invoked through npx and verifies the installed version", () => {
  let version = "1.3.13";
  let installs = 0;
  const executable = resolve("/tools/bun");
  assert.equal(
    ensureBunExecutable({
      platform: "linux",
      env: {},
      invokedViaNpx: true,
      resolveExecutableImpl: () => executable,
      bunCandidatesImpl: () => [],
      commandExistsImpl: () => true,
      bunVersionImpl: () => version,
      spawnSyncImpl() {
        installs += 1;
        version = "1.3.14";
        return { status: 0 };
      },
    }),
    executable,
  );
  assert.equal(installs, 1);
});

test("fails clearly for old Bun outside npx without running an installer", () => {
  assert.throws(
    () =>
      ensureBunExecutable({
        platform: "linux",
        env: {},
        invokedViaNpx: false,
        resolveExecutableImpl: () => "/tools/bun",
        bunCandidatesImpl: () => [],
        commandExistsImpl: () => true,
        bunVersionImpl: () => "1.3.13",
        spawnSyncImpl() {
          assert.fail("installer must not run outside npx");
        },
      }),
    /Bun 1\.3\.13 is too old[\s\S]*1\.3\.14 or newer/,
  );
});

test("reports an actionable automatic Bun installation failure", () => {
  assert.throws(
    () =>
      installBun({
        platform: "linux",
        spawnSyncImpl: () => ({ status: 7 }),
      }),
    /Automatic Bun installation failed: installer exited with status 7[\s\S]*curl -fsSL/,
  );
});

test("locates Bun immediately after the installer finishes", () => {
  const directory = join(tmpdir(), `mekka-cli-bun-install-${process.pid}-${Date.now()}`);
  const executableName = process.platform === "win32" ? "bun.exe" : "bun";
  const installedExecutable = join(directory, "bin", executableName);
  try {
    const resolvedBun = ensureBunExecutable({
      env: { BUN_INSTALL: directory, PATH: "", Path: "" },
      resolveExecutableImpl: () => null,
      bunCandidatesImpl: () => [installedExecutable],
      commandExistsImpl: existsSync,
      bunVersionImpl: () => "1.3.14",
      invokedViaNpx: true,
      spawnSyncImpl() {
        mkdirSync(join(directory, "bin"), { recursive: true });
        writeFileSync(installedExecutable, "installed");
        return { status: 0 };
      },
    });
    assert.equal(resolvedBun, resolve(installedExecutable));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves a Windows executable with an existing extension", () => {
  const directory = join(tmpdir(), `mekka-cli-bin-${process.pid}-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "bun.exe");
  writeFileSync(executable, "");
  try {
    assert.equal(resolveExecutable("bun.exe", { PATH: directory }, "win32"), executable);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("downloads and extracts the GitHub main archive when Git is unavailable", async () => {
  const parentDirectory = join(tmpdir(), `mekka-cli-archive-${process.pid}-${Date.now()}`);
  const targetDirectory = join(parentDirectory, "mekka");
  mkdirSync(parentDirectory, { recursive: true });
  let requestedUrl;
  try {
    await cloneProject(targetDirectory, {
      commandExistsImpl: () => false,
      randomUUIDImpl: () => "fallback",
      fetchImpl: async (url) => {
        requestedUrl = url;
        return new Response(mekkaArchive(), {
          status: 200,
          headers: { "content-length": String(mekkaArchive().length) },
        });
      },
    });

    assert.equal(requestedUrl, "https://github.com/yiaany/Mekka/archive/refs/heads/main.tar.gz");
    assert.equal(isMekkaRepository(targetDirectory), true);
    assert.equal(readFileSync(join(targetDirectory, "README.md"), "utf8"), "Mekka");
    assert.equal(existsSync(`${targetDirectory}.tmp-${process.pid}-fallback`), false);
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true });
  }
});

test("cleans the target and staging directory after a failed archive download", async () => {
  const parentDirectory = join(tmpdir(), `mekka-cli-archive-fail-${process.pid}-${Date.now()}`);
  const targetDirectory = join(parentDirectory, "mekka");
  const stagingDirectory = `${targetDirectory}.tmp-${process.pid}-failed`;
  mkdirSync(parentDirectory, { recursive: true });
  try {
    await assert.rejects(
      cloneProject(targetDirectory, {
        commandExistsImpl: () => false,
        randomUUIDImpl: () => "failed",
        fetchImpl: async () => new Response("unavailable", { status: 503 }),
      }),
      /status 503/,
    );
    assert.equal(existsSync(targetDirectory), false);
    assert.equal(existsSync(stagingDirectory), false);
    assert.equal(existsSync(`${stagingDirectory}.tar.gz`), false);
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true });
  }
});

test("rejects unsafe archive paths and removes all partial extraction", async () => {
  const parentDirectory = join(tmpdir(), `mekka-cli-archive-unsafe-${process.pid}-${Date.now()}`);
  const targetDirectory = join(parentDirectory, "mekka");
  const stagingDirectory = `${targetDirectory}.tmp-${process.pid}-unsafe`;
  mkdirSync(parentDirectory, { recursive: true });
  try {
    await assert.rejects(
      cloneProject(targetDirectory, {
        commandExistsImpl: () => false,
        randomUUIDImpl: () => "unsafe",
        fetchImpl: async () =>
          new Response(
            mekkaArchive([{ path: "Mekka-main/../../escaped.txt", content: "unsafe" }]),
            { status: 200 },
          ),
      }),
      /unsafe path|path contains '\.\.'/,
    );
    assert.equal(existsSync(targetDirectory), false);
    assert.equal(existsSync(stagingDirectory), false);
    assert.equal(existsSync(`${stagingDirectory}.tar.gz`), false);
    assert.equal(existsSync(join(parentDirectory, "escaped.txt")), false);
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true });
  }
});

test("installs only for fresh or incomplete projects unless explicitly overridden", () => {
  const directory = join(tmpdir(), `mekka-cli-deps-${process.pid}-${Date.now()}`);
  for (const path of [
    "node_modules/typescript",
    "apps/studio/node_modules/vite",
    "apps/sqlite-meta/node_modules/elysia",
  ]) {
    mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, path, "package.json"), "{}");
  }
  try {
    assert.equal(shouldInstallDependencies({ install: null }, true, directory), false);
    assert.equal(shouldInstallDependencies({ install: true }, true, directory), true);
    assert.equal(shouldInstallDependencies({ install: false }, false, directory), false);
    assert.equal(shouldStopBeforeBuild({ install: false }, directory), false);
    rmSync(join(directory, "apps/studio/node_modules/vite/package.json"));
    assert.equal(shouldInstallDependencies({ install: null }, true, directory), true);
    assert.equal(shouldStopBeforeBuild({ install: false }, directory), true);
    assert.equal(shouldStopBeforeBuild({ install: null }, directory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("npx resolves the CLI package inside a checkout with a distinct root name", () => {
  const checkout = resolve(import.meta.dirname, "../../..");
  const cleanCheckout = join(tmpdir(), `mekka-cli-npx-${process.pid}-${Date.now()}`);
  const npxCli = resolve(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js");
  const rootPackage = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
  );
  assert.notEqual(rootPackage.name, "mekka");
  mkdirSync(join(cleanCheckout, "packages/mekka-cli/bin"), { recursive: true });
  writeFileSync(
    join(cleanCheckout, "package.json"),
    JSON.stringify({ ...rootPackage, workspaces: ["packages/*", "!packages/mekka-cli"] }),
  );
  writeFileSync(
    join(cleanCheckout, "packages/mekka-cli/package.json"),
    readFileSync(resolve(checkout, "packages/mekka-cli/package.json")),
  );
  writeFileSync(
    join(cleanCheckout, "packages/mekka-cli/bin/mekka.js"),
    readFileSync(resolve(checkout, "packages/mekka-cli/bin/mekka.js")),
  );
  try {
    const result = spawnSync(process.execPath, [npxCli, "mekka", "--version"], {
      cwd: cleanCheckout,
      encoding: "utf8",
      shell: false,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/);
  } finally {
    rmSync(cleanCheckout, { recursive: true, force: true });
  }
});

test("an existing checkout skips install, builds core, and stops when requested", () => {
  const checkout = resolve(import.meta.dirname, "../../..");
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "mekka.js"), "--no-start"],
    {
      cwd: checkout,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /Dependencies are already installed; skipping bun install\./);
  assert.match(result.stdout, /Building Mekka core outputs/);
  assert.match(result.stdout, /Mekka is ready/);
});
