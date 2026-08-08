import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { hasCapability, type TenantContext } from "@mekka/protocol";

export type ConnectFramework = "nextjs" | "vite-react" | "unknown";
export type ConnectPackageManager = "bun" | "pnpm" | "yarn" | "npm" | "unknown";
export type PlanAction = "add" | "create" | "merge" | "review";

export type ConnectAnalyzerLimits = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDurationMs: number;
}>;

export type ConnectIntegrationPlan = Readonly<{
  tenant: TenantContext["tenant"];
  framework: ConnectFramework;
  packageManager: ConnectPackageManager;
  projectPath: string;
  packages: readonly Readonly<{ name: string; action: PlanAction }>[];
  files: readonly Readonly<{
    path: string;
    action: PlanAction;
    purpose: string;
  }>[];
  environment: readonly Readonly<{
    name: string;
    exposure: "client" | "server";
    action: PlanAction;
  }>[];
  mcp: Readonly<{
    path: ".mcp.json";
    action: PlanAction;
    secrets: "forbidden";
  }>;
  migrations: readonly Readonly<{ action: "inspect"; reason: string }>[];
  smokeChecks: readonly string[];
  conflicts: readonly Readonly<{
    path: string;
    reason: string;
    resolution: "merge" | "review";
  }>[];
  warnings: readonly string[];
}>;

export const defaultConnectAnalyzerLimits: ConnectAnalyzerLimits = Object.freeze({
  maxFiles: 2_000,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  maxDurationMs: 2_000,
});

type ScannedFile = Readonly<{ path: string; text: string }>;

const ignoredDirectories = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
const inspectedFileNames = new Set([
  "package.json",
  "bun.lock",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  ".env",
  ".env.local",
  ".env.example",
  ".env.local.example",
  ".mcp.json",
]);

export async function analyzeConnectRepository(
  input: Readonly<{
    context: TenantContext;
    sandboxRoot: string;
    repositoryPath?: string;
    limits?: Partial<ConnectAnalyzerLimits>;
    now?: number;
  }>,
): Promise<ConnectIntegrationPlan> {
  const now = input.now ?? Date.now();
  if (!hasCapability(input.context, "connect:analyze", now))
    throw new ConnectAnalyzerError("forbidden");
  if (!input.sandboxRoot) throw new ConnectAnalyzerError("validation");

  const limits = resolveLimits(input.limits);
  const sandbox = await realpath(input.sandboxRoot).catch(() => {
    throw new ConnectAnalyzerError("validation");
  });
  const sandboxStats = await lstat(sandbox);
  if (!sandboxStats.isDirectory() || sandboxStats.isSymbolicLink())
    throw new ConnectAnalyzerError("validation");
  const repositoryPath = input.repositoryPath ?? ".";
  if (isAbsolute(repositoryPath) || repositoryPath.split(/[\\/]/).includes(".."))
    throw new ConnectAnalyzerError("validation");
  const root = await realpath(resolve(sandbox, repositoryPath)).catch(() => {
    throw new ConnectAnalyzerError("validation");
  });
  assertContained(sandbox, root);
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    throw new ConnectAnalyzerError("validation");

  const scan = await scanRepository(root, limits, now);
  return buildPlan(input.context, scan.files, scan.warnings);
}

function resolveLimits(
  overrides: Partial<ConnectAnalyzerLimits> | undefined,
): ConnectAnalyzerLimits {
  const limits = { ...defaultConnectAnalyzerLimits, ...overrides };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ConnectAnalyzerError("validation");
  }
  return Object.freeze(limits);
}

async function scanRepository(
  root: string,
  limits: ConnectAnalyzerLimits,
  startedAt: number,
): Promise<Readonly<{ files: readonly ScannedFile[]; warnings: readonly string[] }>> {
  const files: ScannedFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;
  let scannedEntries = 0;

  const visit = async (directory: string): Promise<void> => {
    assertWithinTime(startedAt, limits);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      assertWithinTime(startedAt, limits);
      scannedEntries += 1;
      if (scannedEntries > limits.maxFiles) throw new ConnectAnalyzerError("quota");
      const fullPath = resolve(directory, entry.name);
      const relativePath = safeRelativePath(root, fullPath);
      if (entry.isSymbolicLink()) {
        warnings.push(`skipped symlink: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !shouldInspect(relativePath)) continue;
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        warnings.push(`skipped changed path: ${relativePath}`);
        continue;
      }
      if (stats.size > limits.maxFileBytes) {
        warnings.push(`skipped oversized file: ${relativePath}`);
        continue;
      }
      if (totalBytes + stats.size > limits.maxTotalBytes) throw new ConnectAnalyzerError("quota");
      const bytes = await readFile(fullPath);
      totalBytes += bytes.byteLength;
      if (bytes.includes(0)) {
        warnings.push(`skipped binary file: ${relativePath}`);
        continue;
      }
      files.push(Object.freeze({ path: relativePath, text: bytes.toString("utf8") }));
    }
  };

  await visit(root);
  return Object.freeze({
    files: Object.freeze(files),
    warnings: Object.freeze(warnings.sort()),
  });
}

function buildPlan(
  context: TenantContext,
  files: readonly ScannedFile[],
  scanWarnings: readonly string[],
): ConnectIntegrationPlan {
  const packages = files.filter((file) => basename(file.path) === "package.json");
  const project = selectProject(packages);
  const manifest = project === null ? null : parsePackageManifest(project.text);
  const framework = detectFramework(manifest);
  const packageManager = detectPackageManager(files);
  const environment = collectEnvironment(files);
  const conflicts = collectConflicts(files, manifest, environment);
  const hasMcpConfig = files.some((file) => file.path === ".mcp.json");
  const hasIntegration = conflicts.some(
    (conflict) => conflict.reason.includes("Mekka") || conflict.reason.includes("Supabase"),
  );
  const projectPath = project === null ? "." : projectDirectory(project.path);
  const packageAction: PlanAction = hasIntegration ? "review" : "add";
  const warnings = [...scanWarnings];
  if (framework === "unknown")
    warnings.push("unsupported framework: review generated plan before applying");
  if (project === null) warnings.push("package.json was not found");

  return Object.freeze({
    tenant: context.tenant,
    framework,
    packageManager,
    projectPath,
    packages: Object.freeze([Object.freeze({ name: "@mekka/sdk-js", action: packageAction })]),
    files: Object.freeze([
      Object.freeze({
        path: joinProjectPath(projectPath, "src/lib/mekka.ts"),
        action: hasIntegration ? "review" : "create",
        purpose: "typed Mekka client",
      }),
    ]),
    environment: Object.freeze(environment),
    mcp: Object.freeze({
      path: ".mcp.json",
      action: hasMcpConfig ? "merge" : "create",
      secrets: "forbidden",
    }),
    migrations: Object.freeze([
      Object.freeze({
        action: "inspect" as const,
        reason: "generate a schema manifest before proposing any migration",
      }),
    ]),
    smokeChecks: Object.freeze(["install", "typecheck", "build", "mekka health check"]),
    conflicts: Object.freeze(conflicts),
    warnings: Object.freeze(warnings.sort()),
  });
}

function shouldInspect(relativePath: string): boolean {
  return inspectedFileNames.has(basename(relativePath));
}

function selectProject(packages: readonly ScannedFile[]): ScannedFile | null {
  const candidates = packages
    .map((file) => ({ file, manifest: parsePackageManifest(file.text) }))
    .filter(
      (
        candidate,
      ): candidate is Readonly<{
        file: ScannedFile;
        manifest: PackageManifest;
      }> => candidate.manifest !== null,
    )
    .filter((candidate) => detectFramework(candidate.manifest) !== "unknown")
    .sort((left, right) => left.file.path.localeCompare(right.file.path));
  return candidates.at(0)?.file ?? packages.find((file) => file.path === "package.json") ?? null;
}

type PackageManifest = Readonly<{
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
}>;

function parsePackageManifest(text: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.freeze({
      dependencies: readDependencies(record.dependencies),
      devDependencies: readDependencies(record.devDependencies),
    });
  } catch {
    return null;
  }
}

function readDependencies(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return Object.freeze({});
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.freeze(Object.fromEntries(entries));
}

function detectFramework(manifest: PackageManifest | null): ConnectFramework {
  if (manifest === null) return "unknown";
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };
  if ("next" in dependencies) return "nextjs";
  if (
    "vite" in dependencies &&
    ("react" in dependencies || "@vitejs/plugin-react" in dependencies)
  ) {
    return "vite-react";
  }
  return "unknown";
}

function detectPackageManager(files: readonly ScannedFile[]): ConnectPackageManager {
  const paths = new Set(files.map((file) => file.path));
  if (paths.has("bun.lock") || paths.has("bun.lockb")) return "bun";
  if (paths.has("pnpm-lock.yaml")) return "pnpm";
  if (paths.has("yarn.lock")) return "yarn";
  if (paths.has("package-lock.json")) return "npm";
  return "unknown";
}

function collectEnvironment(files: readonly ScannedFile[]) {
  const keys = new Map<string, string>();
  for (const file of files.filter((candidate) => basename(candidate.path).startsWith(".env"))) {
    for (const line of file.text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      const key = match?.[1];
      if (key !== undefined) keys.set(key, file.path);
    }
  }
  return [
    Object.freeze({
      name: "NEXT_PUBLIC_MEKKA_URL",
      exposure: "client" as const,
      action: keys.has("NEXT_PUBLIC_MEKKA_URL") ? ("merge" as const) : ("add" as const),
    }),
    Object.freeze({
      name: "NEXT_PUBLIC_MEKKA_PUBLISHABLE_KEY",
      exposure: "client" as const,
      action: keys.has("NEXT_PUBLIC_MEKKA_PUBLISHABLE_KEY") ? ("merge" as const) : ("add" as const),
    }),
  ];
}

function collectConflicts(
  files: readonly ScannedFile[],
  manifest: PackageManifest | null,
  environment: readonly Readonly<{ name: string; action: PlanAction }>[],
) {
  const conflicts: Array<
    Readonly<{ path: string; reason: string; resolution: "merge" | "review" }>
  > = [];
  const dependencies =
    manifest === null ? {} : { ...manifest.dependencies, ...manifest.devDependencies };
  if ("@supabase/supabase-js" in dependencies) {
    conflicts.push(
      Object.freeze({
        path: "package.json",
        reason: "existing Supabase client",
        resolution: "review",
      }),
    );
  }
  if ("@mekka/sdk-js" in dependencies) {
    conflicts.push(
      Object.freeze({
        path: "package.json",
        reason: "existing Mekka SDK",
        resolution: "merge",
      }),
    );
  }
  for (const variable of environment.filter((item) => item.action === "merge")) {
    conflicts.push(
      Object.freeze({
        path: ".env*",
        reason: `existing ${variable.name}`,
        resolution: "merge",
      }),
    );
  }
  for (const file of files.filter((candidate) => basename(candidate.path).startsWith(".env"))) {
    if (/^\s*(?:export\s+)?(?:LITEBASE|MEKKA)_[A-Za-z0-9_]+\s*=/m.test(file.text)) {
      conflicts.push(
        Object.freeze({
          path: file.path,
          reason: "existing Mekka or legacy Litebase environment",
          resolution: "merge",
        }),
      );
    }
    if (/=\s*(?:sk_|pk_|eyJ|-----BEGIN)/m.test(file.text)) {
      conflicts.push(
        Object.freeze({
          path: file.path,
          reason: "secret-like value redacted",
          resolution: "review",
        }),
      );
    }
  }
  return conflicts.sort((left, right) =>
    `${left.path}:${left.reason}`.localeCompare(`${right.path}:${right.reason}`),
  );
}

function safeRelativePath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    resolve(root, path) !== candidate
  ) {
    throw new ConnectAnalyzerError("forbidden");
  }
  return path.split(sep).join("/");
}

function assertContained(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new ConnectAnalyzerError("forbidden");
}

function projectDirectory(packagePath: string): string {
  const separator = packagePath.lastIndexOf("/");
  return separator < 0 ? "." : packagePath.slice(0, separator);
}

function joinProjectPath(projectPath: string, filePath: string): string {
  return projectPath === "." ? filePath : `${projectPath}/${filePath}`;
}

function assertWithinTime(startedAt: number, limits: ConnectAnalyzerLimits): void {
  if (Date.now() - startedAt > limits.maxDurationMs) throw new ConnectAnalyzerError("quota");
}

export class ConnectAnalyzerError extends Error {
  constructor(readonly code: "validation" | "forbidden" | "quota") {
    super(code);
    this.name = "ConnectAnalyzerError";
  }
}
