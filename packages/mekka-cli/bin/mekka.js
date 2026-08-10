#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { x as extractTar } from "tar";

const repositoryUrl = "https://github.com/yiaany/Mekka.git";
// v0.1.0 predates this launcher. Pin this to the matching release tag before publishing the
// next CLI; main is retained temporarily so 0.1.2 does not download an incompatible project.
const repositoryRef = "main";
const repositoryArchiveUrl = `https://github.com/yiaany/Mekka/archive/refs/heads/${repositoryRef}.tar.gz`;
const repositoryArchiveRoot = `Mekka-${repositoryRef}`;
const minimumBunVersion = "1.3.14";
const maxArchiveBytes = 250 * 1024 * 1024;
const maxExtractedBytes = 2 * 1024 * 1024 * 1024;
const maxArchiveEntries = 100_000;

export function parseArguments(args) {
  const options = {
    directory: null,
    install: null,
    start: true,
    help: false,
    version: false,
  };

  for (const argument of args) {
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
    else if (argument === "--install") options.install = true;
    else if (argument === "--no-install") options.install = false;
    else if (argument === "--no-start") options.start = false;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (options.directory) throw new Error("Mekka accepts at most one target directory.");
    else options.directory = argument;
  }

  return options;
}

export function isMekkaRepository(directory) {
  const packagePath = resolve(directory, "package.json");
  if (!existsSync(packagePath)) return false;

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    return (
      packageJson.name === "mekka-workspace" &&
      packageJson.scripts?.["dev:studio"] !== undefined &&
      packageJson.workspaces?.includes("apps/*") &&
      packageJson.workspaces?.includes("packages/*")
    );
  } catch {
    return false;
  }
}

export function resolveTargetDirectory(cwd, requestedDirectory) {
  if (requestedDirectory) return resolve(cwd, requestedDirectory);
  return isMekkaRepository(cwd) ? cwd : resolve(cwd, "mekka");
}

export function missingBunMessage(
  platform = process.platform,
  reason = "Bun could not be installed.",
) {
  const installCommand =
    platform === "win32"
      ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
      : "curl -fsSL https://bun.sh/install | bash";

  return `${reason}

Mekka uses Bun's native SQLite driver and cannot start without Bun 1.3.14 or newer.

Install Bun:
  ${installCommand}

Install Bun manually, then run npx mekka again.

Installation guide: https://bun.sh/docs/installation`;
}

function printHelp() {
  console.log(`Mekka

Usage:
  npx mekka [directory] [options]
  npx mekka mcp-stdio --url <https-url> [--token-env <name>]

Examples:
  npx mekka
  npx mekka my-app
  npx mekka --install
  npx mekka my-app --no-start
  npx mekka mcp-stdio --url https://example.com/mcp --token-env MEKKA_MCP_TOKEN

Options:
  --install     Reinstall dependencies even when they are already present
  --no-install  Do not install dependencies
  --no-start    Prepare the project without starting Mekka
  -h, --help    Show this help
  -v, --version Show the CLI version

Prerequisite for npx: Node.js 20 or newer. Git is optional.
Prerequisite for bunx: Bun.`);
}

function commandExists(command, versionArgument = "--version") {
  const result = spawnSync(command, [versionArgument], { stdio: "ignore", shell: false });
  return result.status === 0;
}

export function resolveExecutable(command, env = process.env, platform = process.platform) {
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? resolve(command) : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions =
    platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  const pathDelimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return resolve(candidate);
      const uppercaseCandidate = join(directory, `${command}${extension.toUpperCase()}`);
      if (existsSync(uppercaseCandidate)) return resolve(uppercaseCandidate);
    }
  }
  return null;
}

export function bunCandidates(env = process.env, platform = process.platform) {
  const executable = platform === "win32" ? "bun.exe" : "bun";
  return [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin", executable) : null,
    join(homedir(), ".bun", "bin", executable),
  ].filter(Boolean);
}

export function installBun({
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  console.log(`Installing Bun ${minimumBunVersion} or newer with Bun's official installer...`);
  const installer =
    platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "irm bun.sh/install.ps1 | iex",
          ],
        }
      : {
          command: "bash",
          args: ["-c", "curl -fsSL https://bun.sh/install | bash"],
        };
  const result = spawnSyncImpl(installer.command, installer.args, {
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? `installer exited with status ${result.status ?? "unknown"}`;
    throw new Error(missingBunMessage(platform, `Automatic Bun installation failed: ${detail}`));
  }
}

export function compareVersions(left, right) {
  const parse = (version) => {
    const match = String(version)
      .trim()
      .match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function isNpxInvocation(env = process.env) {
  return (
    env.npm_command === "exec" &&
    /(?:^|[\\/])npm(?:-cli)?(?:\.js|\.cmd)?$/i.test(env.npm_execpath ?? "")
  );
}

function bunVersion(executable, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(executable, ["--version"], {
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).trim();
}

export function ensureBunExecutable({
  env = process.env,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  commandExistsImpl = commandExists,
  resolveExecutableImpl = resolveExecutable,
  bunCandidatesImpl = bunCandidates,
  bunVersionImpl = (executable) => bunVersion(executable, spawnSyncImpl),
  invokedViaNpx = isNpxInvocation(env),
} = {}) {
  const checked = new Set();
  const findBun = ({ continueAfterOutdated = false } = {}) => {
    const candidates = [
      resolveExecutableImpl(platform === "win32" ? "bun.exe" : "bun", env, platform),
      ...bunCandidatesImpl(env, platform),
    ].filter(Boolean);
    for (const candidate of candidates) {
      const executable = resolve(candidate);
      if (checked.has(executable) || !commandExistsImpl(executable)) continue;
      checked.add(executable);
      const version = bunVersionImpl(executable);
      const comparison = compareVersions(version, minimumBunVersion);
      if (comparison !== null && comparison >= 0) return { executable, version };
      if (comparison === null) {
        throw new Error(`Could not determine the Bun version reported by ${executable}.`);
      }
      if (!invokedViaNpx) {
        throw new Error(
          missingBunMessage(
            platform,
            `Bun ${version} is too old; Mekka requires Bun ${minimumBunVersion} or newer.`,
          ),
        );
      }
      if (continueAfterOutdated) continue;
      console.log(`Bun ${version} is too old. Upgrading Bun...`);
      return null;
    }
    return null;
  };

  const existing = findBun();
  if (existing) return existing.executable;
  if (!invokedViaNpx) throw new Error(missingBunMessage(platform, "Bun was not found."));

  installBun({ platform, env, spawnSyncImpl });
  checked.clear();
  const installed = findBun({ continueAfterOutdated: true });
  if (installed) return installed.executable;

  throw new Error(
    missingBunMessage(
      platform,
      `Bun's installer completed, but Bun ${minimumBunVersion} or newer could not be located.`,
    ),
  );
}

export function dependenciesPresent(directory) {
  return [
    "node_modules/typescript/package.json",
    "apps/studio/node_modules/vite/package.json",
    "apps/sqlite-meta/node_modules/elysia/package.json",
  ].every((path) => existsSync(resolve(directory, path)));
}

export function shouldInstallDependencies(options, existingProject, directory) {
  return (
    options.install === true ||
    (!existingProject && options.install !== false) ||
    (options.install === null && !dependenciesPresent(directory))
  );
}

export function shouldStopBeforeBuild(options, directory) {
  return options.install === false && !dependenciesPresent(directory);
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function start(command, args, cwd, env = process.env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });

  child.on("error", (error) => {
    console.error(`Failed to start Mekka: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

function validateArchiveEntry(path, entry) {
  if (path.includes("\0")) throw new Error("Archive contains a path with a null byte.");

  const normalizedPath = path.replaceAll("\\", "/").replace(/\/$/, "");
  const parts = normalizedPath.split("/");
  const strippedPath = parts.slice(1).join("/");
  if (
    normalizedPath.startsWith("/") ||
    /^[A-Za-z]:/.test(normalizedPath) ||
    /^[A-Za-z]:/.test(strippedPath) ||
    parts[0] !== repositoryArchiveRoot ||
    parts.slice(1).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Archive contains an unsafe path: ${path}`);
  }
  if (entry.type !== "File" && entry.type !== "Directory") {
    throw new Error(`Archive contains an unsupported ${entry.type} entry: ${path}`);
  }
}

async function downloadProjectArchive(targetDirectory, archivePath, fetchImpl) {
  const response = await fetchImpl(repositoryArchiveUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`GitHub archive download failed with status ${response.status}.`);
  }
  if (new URL(response.url || repositoryArchiveUrl).protocol !== "https:") {
    throw new Error("GitHub archive download redirected to a non-HTTPS URL.");
  }
  if (!response.body) throw new Error("GitHub archive download returned an empty response.");

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxArchiveBytes) {
    throw new Error("GitHub archive is larger than the allowed download size.");
  }

  let downloadedBytes = 0;
  let extractedBytes = 0;
  let archiveEntries = 0;
  let archiveError;
  const limitDownload = new Transform({
    transform(chunk, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxArchiveBytes) {
        callback(new Error("GitHub archive is larger than the allowed download size."));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limitDownload, createWriteStream(archivePath));
  await extractTar({
    cwd: targetDirectory,
    file: archivePath,
    strip: 1,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    maxDepth: 100,
    filter(path, entry) {
      if (archiveError) return false;
      try {
        validateArchiveEntry(path, entry);
        archiveEntries += 1;
        extractedBytes += entry.size;
        if (archiveEntries > maxArchiveEntries || extractedBytes > maxExtractedBytes) {
          throw new Error("GitHub archive exceeds the allowed extraction limits.");
        }
        return true;
      } catch (error) {
        archiveError = error;
        return false;
      }
    },
  });
  if (archiveError) throw archiveError;
}

export async function cloneProject(
  targetDirectory,
  {
    commandExistsImpl = commandExists,
    spawnSyncImpl = spawnSync,
    fetchImpl = globalThis.fetch,
    randomUUIDImpl = randomUUID,
  } = {},
) {
  const parentDirectory = resolve(targetDirectory, "..");
  if (!existsSync(parentDirectory)) {
    throw new Error(`Parent directory does not exist: ${parentDirectory}`);
  }
  if (existsSync(targetDirectory)) {
    throw new Error(`Target already exists: ${targetDirectory}`);
  }

  console.log(`Creating Mekka in ${targetDirectory}...`);
  if (commandExistsImpl("git")) {
    try {
      const result = spawnSyncImpl(
        "git",
        ["clone", "--depth", "1", "--branch", repositoryRef, repositoryUrl, targetDirectory],
        {
          cwd: parentDirectory,
          stdio: "inherit",
          shell: false,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Git clone failed with status ${result.status ?? "unknown"}.`);
      }

      // A generated project should not inherit Mekka's upstream Git history.
      rmSync(resolve(targetDirectory, ".git"), { recursive: true, force: true });
      return;
    } catch (error) {
      rmSync(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  const stagingDirectory = `${targetDirectory}.tmp-${process.pid}-${randomUUIDImpl()}`;
  const archivePath = `${stagingDirectory}.tar.gz`;
  try {
    await mkdir(stagingDirectory);
    await downloadProjectArchive(stagingDirectory, archivePath, fetchImpl);
    if (!isMekkaRepository(stagingDirectory)) {
      throw new Error("GitHub archive did not contain a valid Mekka project.");
    }
    await rm(archivePath, { force: true });
    await rename(stagingDirectory, targetDirectory);
  } catch (error) {
    await rm(archivePath, { force: true });
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  if (args[0] === "mcp-stdio") {
    const { runMcpStdioBridge } = await import("./mcp-stdio.js");
    await runMcpStdioBridge(args.slice(1));
    return;
  }
  const options = parseArguments(args);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    console.log(JSON.parse(readFileSync(packagePath, "utf8")).version);
    return;
  }
  const bunExecutable = ensureBunExecutable();

  const targetDirectory = resolveTargetDirectory(cwd, options.directory);
  const existingProject = isMekkaRepository(targetDirectory);
  if (!existingProject) {
    await cloneProject(targetDirectory);
  }

  const shouldInstall = shouldInstallDependencies(options, existingProject, targetDirectory);
  if (shouldInstall) {
    console.log("Installing dependencies with Bun...");
    run(bunExecutable, ["install", "--frozen-lockfile"], targetDirectory);
  } else if (options.install === null) {
    console.log("Dependencies are already installed; skipping bun install.");
  }

  if (shouldStopBeforeBuild(options, targetDirectory)) {
    const startCommand = existingProject
      ? `${bunExecutable} install --frozen-lockfile && ${bunExecutable} run dev`
      : `cd ${basename(targetDirectory)} && ${bunExecutable} install --frozen-lockfile && ${bunExecutable} run dev`;
    console.log(`Mekka source is ready in ${targetDirectory}; dependencies were not installed.`);
    console.log(`Install and start it with: ${startCommand}`);
    return;
  }

  console.log("Building Mekka core outputs...");
  run(bunExecutable, ["run", "build:core"], targetDirectory);

  if (!options.start) {
    console.log(`Mekka is ready in ${targetDirectory}.`);
    const startCommand = existingProject
      ? `${bunExecutable} run dev`
      : `cd ${basename(targetDirectory)} && ${bunExecutable} run dev`;
    console.log(`Start it with: ${startCommand}`);
    return;
  }

  console.log("Starting Mekka at http://127.0.0.1:8082 ...");
  start(bunExecutable, ["run", "dev"], targetDirectory, {
    ...process.env,
    MEKKA_BUN_EXECUTABLE: bunExecutable,
    MEKKA_CORE_BUILT: "1",
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(realpathSync(resolve(process.argv[1]))).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Mekka could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
