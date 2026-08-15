import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const rootPackage = readPackage(root);
const testFilePattern = /(?:^|\/).+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);

const bunTestWorkspaces = new Set([
  "apps/gateway",
  "apps/health-service",
  "apps/mcp",
  "apps/sqlite-meta",
  "packages/auth-core",
  "packages/branch-core",
  "packages/engine-core",
  "packages/migration-engine",
  "packages/onboarding-core",
  "packages/policy-engine",
  "packages/protocol",
  "packages/query-ast",
  "packages/realtime-core",
  "packages/schema-manifest",
  "packages/sqlite-compiler",
  "packages/storage-core",
  "packages/studio-domain-sdk",
]);

const vitestWithoutPackageScript = new Set(["packages/common"]);
const packageTestArguments = new Map([["apps/studio", ["--exclude", "tests/fork/**"]]]);
const requiredTestEnvironment = new Map([["packages/ai-commands", ["OPENAI_API_KEY"]]]);
const unsupportedPlatforms = new Map([["packages/pg-meta", ["win32"]]]);
const separateScriptSuites = [
  {
    workspace: "apps/studio",
    prefix: "tests/fork/",
    rootScript: "test:studio:fork",
    packageScript: "test:fork",
  },
];

function readPackage(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

function workspaceDirectories() {
  const excludedWorkspaces = new Set(
    rootPackage.workspaces
      .filter((workspacePattern) => workspacePattern.startsWith("!"))
      .map((workspacePattern) => workspacePattern.slice(1)),
  );
  return rootPackage.workspaces
    .filter((workspacePattern) => !workspacePattern.startsWith("!"))
    .flatMap((workspacePattern) => {
      if (!workspacePattern.endsWith("/*")) {
        throw new Error(`Unsupported workspace pattern: ${workspacePattern}`);
      }

      const parent = path.join(root, workspacePattern.slice(0, -2));
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.posix.join(workspacePattern.slice(0, -2), entry.name))
        .filter(
          (workspace) =>
            !excludedWorkspaces.has(workspace) &&
            existsSync(path.join(root, workspace, "package.json")),
        );
    });
}

function testFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : testFiles(path.join(directory, entry.name), relativePath);
    }
    return testFilePattern.test(`/${relativePath}`) ? [relativePath] : [];
  });
}

function packageTestCommand(workspace, packageJson) {
  const scripts = packageJson.scripts ?? {};
  const extraArguments = packageTestArguments.get(workspace) ?? [];
  if (scripts["test:ci"]) return ["run", "--cwd", workspace, "test:ci", ...extraArguments];
  if (scripts["test:coverage"])
    return ["run", "--cwd", workspace, "test:coverage", ...extraArguments];
  if (!scripts.test) return null;

  if (/\bvitest\b/.test(scripts.test) && !/\bvitest\s+run\b/.test(scripts.test)) {
    return ["run", "--cwd", workspace, "vitest", "--run"];
  }
  return ["run", "--cwd", workspace, "test", ...extraArguments];
}

function runBun(args, { exitOnFailure = true } = {}) {
  const result = spawnSync("bun", args, {
    cwd: root,
    env: { ...process.env, CI: process.env.CI ?? "true" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && exitOnFailure) process.exit(result.status ?? 1);
  return result.status === 0;
}

const workspaces = workspaceDirectories().sort();
const testWorkspaces = workspaces
  .map((workspace) => ({
    workspace,
    packageJson: readPackage(path.join(root, workspace)),
    files: testFiles(path.join(root, workspace)),
  }))
  .filter(({ files }) => files.length > 0);

function checkCoverage() {
  const errors = [];
  const knownWorkspaces = new Set(workspaces);
  const workspacesWithTests = new Set(testWorkspaces.map(({ workspace }) => workspace));

  for (const workspace of [...bunTestWorkspaces, ...vitestWithoutPackageScript]) {
    if (!knownWorkspaces.has(workspace))
      errors.push(`Configured workspace does not exist: ${workspace}`);
    else if (!workspacesWithTests.has(workspace)) {
      errors.push(`Configured workspace has no test files: ${workspace}`);
    }
  }

  for (const { workspace, packageJson, files } of testWorkspaces) {
    const modes = [
      bunTestWorkspaces.has(workspace),
      vitestWithoutPackageScript.has(workspace),
      packageTestCommand(workspace, packageJson) !== null,
    ].filter(Boolean).length;

    if (modes === 0) {
      errors.push(`${workspace} has ${files.length} test file(s) but no CI test runner`);
    } else if (modes > 1) {
      errors.push(`${workspace} is assigned to more than one CI test runner`);
    }
  }

  for (const { workspace, prefix, rootScript, packageScript } of separateScriptSuites) {
    const rootCommand = rootPackage.scripts?.[rootScript];
    if (!rootCommand) {
      errors.push(`Missing root script for ${workspace}/${prefix}: ${rootScript}`);
      continue;
    }

    const suite = testWorkspaces.find((entry) => entry.workspace === workspace);
    const packageCommand = suite?.packageJson.scripts?.[packageScript];
    if (!packageCommand || !rootCommand.includes(packageScript)) {
      errors.push(`${rootScript} must invoke ${workspace} script ${packageScript}`);
      continue;
    }

    for (const file of suite?.files.filter((candidate) => candidate.startsWith(prefix)) ?? []) {
      if (!packageCommand.includes(file)) {
        errors.push(`${workspace}/${file} is not covered by root script ${rootScript}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }

  const fileCount = testWorkspaces.reduce((total, workspace) => total + workspace.files.length, 0);
  console.log(
    `Workspace test policy covers ${fileCount} test files in ${testWorkspaces.length} workspaces.`,
  );
}

const mode = process.argv[2];
checkCoverage();

if (mode === "--check") process.exit(0);

if (mode === "--bun") {
  const files = testWorkspaces.flatMap(({ workspace, files }) =>
    bunTestWorkspaces.has(workspace) ? files.map((file) => path.posix.join(workspace, file)) : [],
  );
  runBun(["test", ...files]);
  process.exit(0);
}

if (mode === "--workspaces") {
  const failures = [];
  const scriptWorkspaces = testWorkspaces
    .filter(({ workspace }) => !bunTestWorkspaces.has(workspace))
    .sort((left, right) => {
      if (left.workspace === "apps/studio") return 1;
      if (right.workspace === "apps/studio") return -1;
      return left.workspace.localeCompare(right.workspace);
    });

  for (const { workspace, packageJson } of scriptWorkspaces) {
    console.log(`\n==> ${workspace}`);
    const missingEnvironment = (requiredTestEnvironment.get(workspace) ?? []).filter(
      (name) => !process.env[name],
    );
    if (missingEnvironment.length > 0) {
      console.log(`Skipped: missing ${missingEnvironment.join(", ")}.`);
      continue;
    }
    if ((unsupportedPlatforms.get(workspace) ?? []).includes(process.platform)) {
      console.log(`Skipped: unsupported on ${process.platform}.`);
      continue;
    }

    if (vitestWithoutPackageScript.has(workspace)) {
      if (!runBun(["run", "--cwd", workspace, "vitest", "--run"], { exitOnFailure: false })) {
        failures.push(workspace);
      }
      continue;
    }

    if (!runBun(packageTestCommand(workspace, packageJson), { exitOnFailure: false })) {
      failures.push(workspace);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFailed workspace test suites: ${failures.join(", ")}`);
    process.exit(1);
  }
  process.exit(0);
}

console.error("Usage: node scripts/workspace-tests.mjs --check|--bun|--workspaces");
process.exit(2);
