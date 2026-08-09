#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryUrl = "https://github.com/yiaany/Mekka.git";

export function parseArguments(args) {
  const options = {
    directory: null,
    install: true,
    start: true,
    help: false,
    version: false,
  };

  for (const argument of args) {
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--version" || argument === "-v") options.version = true;
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
    return packageJson.name === "mekka" && packageJson.scripts?.["dev:studio"] !== undefined;
  } catch {
    return false;
  }
}

export function resolveTargetDirectory(cwd, requestedDirectory) {
  if (requestedDirectory) return resolve(cwd, requestedDirectory);
  return isMekkaRepository(cwd) ? cwd : resolve(cwd, "mekka");
}

export function missingBunMessage(platform = process.platform) {
  const installCommand =
    platform === "win32"
      ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
      : "curl -fsSL https://bun.sh/install | bash";

  return `Bun is not installed.

Mekka uses Bun's native SQLite driver and cannot start without Bun 1.3.14 or newer.

Install Bun:
  ${installCommand}

Then open a new terminal and run:
  npx mekka

Installation guide: https://bun.sh/docs/installation`;
}

function printHelp() {
  console.log(`Mekka

Usage:
  npx mekka [directory] [options]

Examples:
  npx mekka
  npx mekka my-app
  npx mekka my-app --no-start

Options:
  --no-install  Clone without installing dependencies
  --no-start    Prepare the project without starting Mekka
  -h, --help    Show this help
  -v, --version Show the CLI version`);
}

function commandExists(command, versionArgument = "--version") {
  const result = spawnSync(command, [versionArgument], { stdio: "ignore", shell: false });
  return result.status === 0;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function start(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
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

function cloneProject(targetDirectory) {
  const parentDirectory = resolve(targetDirectory, "..");
  if (!existsSync(parentDirectory)) {
    throw new Error(`Parent directory does not exist: ${parentDirectory}`);
  }
  if (existsSync(targetDirectory)) {
    throw new Error(`Target already exists: ${targetDirectory}`);
  }

  console.log(`Creating Mekka in ${targetDirectory}...`);
  const result = spawnSync("git", ["clone", "--depth", "1", repositoryUrl, targetDirectory], {
    cwd: parentDirectory,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  // A generated project should not inherit Mekka's upstream Git history.
  rmSync(resolve(targetDirectory, ".git"), { recursive: true, force: true });
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
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
  if (!commandExists("bun")) throw new Error(missingBunMessage());
  if (!commandExists("git")) throw new Error("Git is required to download Mekka.");

  const targetDirectory = resolveTargetDirectory(cwd, options.directory);
  const existingProject = isMekkaRepository(targetDirectory);
  if (!existingProject) cloneProject(targetDirectory);

  if (options.install) {
    console.log("Installing dependencies with Bun...");
    run("bun", ["install", "--frozen-lockfile"], targetDirectory);
  }

  if (!options.start) {
    console.log(`Mekka is ready in ${targetDirectory}.`);
    const startCommand = existingProject
      ? "bun run dev"
      : `cd ${basename(targetDirectory)} && bun run dev`;
    console.log(`Start it with: ${startCommand}`);
    return;
  }

  console.log("Starting Mekka at http://127.0.0.1:8082 ...");
  start("bun", ["run", "dev"], targetDirectory);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`Mekka could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
