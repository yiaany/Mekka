import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCorrelationId, createTenantContext, parseTenantIdentity } from "@mekka/protocol";
import {
  analyzeConnectRepository,
  type ConnectAnalyzerError,
  defaultConnectAnalyzerLimits,
} from "../src/connect-analyzer";

describe("Connect Analyzer", () => {
  test("creates a deterministic Next.js plan without executing repository scripts", async () => {
    await withRepository(async (root) => {
      await write(
        root,
        "package.json",
        JSON.stringify({
          dependencies: { next: "16.0.0", react: "19.0.0" },
          scripts: { postinstall: "touch PWNED" },
        }),
      );
      await write(root, "bun.lock", "lockfile");
      await write(
        root,
        ".env.example",
        "NEXT_PUBLIC_API_URL=https://example.test\nSECRET_KEY=sk_live_never_return",
      );

      const first = await analyzeConnectRepository({
        context: context(),
        sandboxRoot: root,
      });
      const second = await analyzeConnectRepository({
        context: context(),
        sandboxRoot: root,
      });

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        framework: "nextjs",
        packageManager: "bun",
        projectPath: ".",
      });
      expect(first.environment).toEqual([
        { name: "NEXT_PUBLIC_MEKKA_URL", exposure: "client", action: "add" },
        {
          name: "NEXT_PUBLIC_MEKKA_PUBLISHABLE_KEY",
          exposure: "client",
          action: "add",
        },
      ]);
      expect(first.conflicts).toContainEqual({
        path: ".env.example",
        reason: "secret-like value redacted",
        resolution: "review",
      });
      await expect(readFile(join(root, "PWNED"))).rejects.toThrow();
      expect(JSON.stringify(first)).not.toContain("sk_live_never_return");
    });
  });

  test("selects a framework package in a monorepo and proposes merges for existing integrations", async () => {
    await withRepository(async (root) => {
      await write(root, "package.json", JSON.stringify({ workspaces: ["apps/*"] }));
      await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'");
      await write(
        root,
        "apps/web/package.json",
        JSON.stringify({
          dependencies: {
            vite: "6.0.0",
            react: "19.0.0",
            "@supabase/supabase-js": "2.0.0",
          },
        }),
      );
      await write(
        root,
        "apps/web/.env.local",
        "LITEBASE_URL=https://api.example.test\nNEXT_PUBLIC_LITEBASE_URL=https://old.example.test",
      );
      await write(root, ".mcp.json", "{}");

      const plan = await analyzeConnectRepository({
        context: context(),
        sandboxRoot: root,
      });

      expect(plan).toMatchObject({
        framework: "vite-react",
        packageManager: "pnpm",
        projectPath: "apps/web",
      });
      expect(plan.packages).toEqual([{ name: "@mekka/sdk-js", action: "review" }]);
      expect(plan.mcp).toEqual({
        path: ".mcp.json",
        action: "merge",
        secrets: "forbidden",
      });
      expect(plan.conflicts).toEqual(
        expect.arrayContaining([
          {
            path: "package.json",
            reason: "existing Supabase client",
            resolution: "review",
          },
          {
            path: "apps/web/.env.local",
            reason: "existing Mekka or legacy Litebase environment",
            resolution: "merge",
          },
        ]),
      );
    });
  });

  test("does not follow symlinks, does not process binary input, and enforces limits", async () => {
    await withRepository(async (root) => {
      await write(
        root,
        "package.json",
        JSON.stringify({ dependencies: { vite: "6.0.0", react: "19.0.0" } }),
      );
      await write(root, ".env.example", Buffer.from([0, 1, 2]));
      const outside = join(tmpdir(), `connect-analyzer-outside-${crypto.randomUUID()}.env`);
      await writeFile(outside, "STEAL_ME=sk_live_outside");
      let hasSymlink = false;
      try {
        await symlink(outside, join(root, "leak.env"), "file");
        hasSymlink = true;
        const plan = await analyzeConnectRepository({
          context: context(),
          sandboxRoot: root,
        });
        expect(plan.warnings).toContain("skipped binary file: .env.example");
        if (hasSymlink) expect(plan.warnings).toContain("skipped symlink: leak.env");
        expect(JSON.stringify(plan)).not.toContain("sk_live_outside");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("operation not permitted"))
          throw error;
        const plan = await analyzeConnectRepository({
          context: context(),
          sandboxRoot: root,
        });
        expect(plan.warnings).toContain("skipped binary file: .env.example");
      } finally {
        await rm(outside, { force: true });
      }

      await expect(
        analyzeConnectRepository({
          context: context(),
          sandboxRoot: root,
          limits: { ...defaultConnectAnalyzerLimits, maxTotalBytes: 1 },
        }),
      ).rejects.toMatchObject<Partial<ConnectAnalyzerError>>({ code: "quota" });
      await expect(
        analyzeConnectRepository({
          context: context(false),
          sandboxRoot: root,
        }),
      ).rejects.toMatchObject<Partial<ConnectAnalyzerError>>({
        code: "forbidden",
      });
      await expect(
        analyzeConnectRepository({
          context: context(),
          sandboxRoot: root,
          repositoryPath: "../outside",
        }),
      ).rejects.toMatchObject<Partial<ConnectAnalyzerError>>({
        code: "validation",
      });
    });
  });
});

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mekka-connect-analyzer-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root: string, path: string, value: string | Buffer): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, value);
}

function context(canAnalyze = true) {
  const tenant = parseTenantIdentity({
    organizationId: "org-connect",
    projectId: "prj-connect",
    environmentId: "env-preview",
    branchId: "brn-connect",
    generation: 1,
  });
  return createTenantContext({
    tenant,
    actor: { kind: "user", id: "user-connect" },
    capabilities: canAnalyze
      ? [
          {
            id: "cap-connect",
            tenant,
            actions: ["connect:analyze"],
            expiresAt: Date.now() + 60_000,
          },
        ]
      : [
          {
            id: "cap-other",
            tenant,
            actions: ["connect:apply"],
            expiresAt: Date.now() + 60_000,
          },
        ],
    correlationId: createCorrelationId(),
  });
}
