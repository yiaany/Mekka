import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LocalAuthEmailSink,
  openProjectAuthService,
  type AuthAdminAuditEvent,
  type AuthAdminSecretName,
  type AuthEmailProvider,
  type AuthSigningKeySet,
} from "@mekka/auth-core";
import { parseTenantIdentity } from "@mekka/protocol";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const tenant = parseTenantIdentity({
  organizationId: process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? "org-local",
  projectId: "local",
  environmentId: process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? "env-local",
  branchId: process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? "branch-main",
  generation: Number(process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? "1"),
});

export async function openLocalAuthRuntime(dataDirectory: string) {
  const authDirectory = join(dataDirectory, "auth");
  await mkdir(authDirectory, { recursive: true });
  const publicOrigin = process.env.AUTH_PUBLIC_ORIGIN ?? "http://127.0.0.1:8082";
  const sessionSecret =
    process.env.MEKKA_AUTH_SESSION_SECRET ?? "local-only-auth-session-secret-that-is-long-enough";
  const oauthFile = join(authDirectory, "oauth-secrets.json");
  const oauthSecrets = await readJson<Record<string, string>>(oauthFile, {});
  const localEmailSink = process.env.MEKKA_LOCAL_DEV === "1" ? new LocalAuthEmailSink() : null;
  const emailProvider = localEmailSink ?? createResendEmailProvider();
  const signingKeySet = await loadSigningKeySet(join(authDirectory, "signing-key.json"));
  const secretStore = {
    async readSecret({ name }: { name: string }): Promise<string> {
      if (name === "auth/session-secret") return sessionSecret;
      return oauthSecrets[name] ?? "";
    },
    async writeSecrets(
      inputs: readonly Readonly<{
        name: AuthAdminSecretName;
        value: string;
      }>[],
    ): Promise<void> {
      for (const input of inputs) oauthSecrets[input.name] = input.value;
      await writeFile(oauthFile, JSON.stringify(oauthSecrets, null, 2), "utf8");
    },
  };
  const auditFile = join(authDirectory, "admin-audit.ndjson");
  const service = await openProjectAuthService({
    tenant,
    mode: { kind: "production" },
    authStorageDirectory: authDirectory,
    publicOrigin,
    secretStore,
    emailProvider,
    signingKeyStore: {
      async readSigningKeySet(): Promise<AuthSigningKeySet> {
        return signingKeySet;
      },
    },
    domainOwnershipVerifier: {
      async isVerifiedOrigin(): Promise<boolean> {
        return true;
      },
    },
    admin: {
      studioOrigin: publicOrigin,
      secretStore,
      auditSink: {
        async append(event: AuthAdminAuditEvent): Promise<void> {
          await appendFile(auditFile, `${JSON.stringify(event)}\n`, "utf8");
        },
      },
    },
  });

  return Object.freeze({
    binding: service.binding,
    verifyAccessToken(token: string) {
      return service.verifyAccessToken(token);
    },
    async handlePublicRequest(request: Request): Promise<Response> {
      const incoming = new URL(request.url);
      const marker = "/auth/";
      const markerIndex = incoming.pathname.indexOf(marker);
      if (markerIndex < 0) return Response.json({ error: "not_found" }, { status: 404 });
      const path = incoming.pathname.slice(
        markerIndex + service.binding.issuer.length - publicOrigin.length,
      );
      const target = `${service.binding.issuer}${path}${incoming.search}`;
      return service.handleRequest(new Request(target, request));
    },
    async handleAdminRequest(request: Request, projectRef: string): Promise<Response> {
      if (projectRef !== "local") {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      const incoming = new URL(request.url);
      const marker = `/auth-admin/${projectRef}`;
      const markerIndex = incoming.pathname.indexOf(marker);
      const path =
        markerIndex < 0 ? "/" : incoming.pathname.slice(markerIndex + marker.length) || "/";
      const headers = new Headers(request.headers);
      headers.set("origin", publicOrigin);
      const csrfToken = headers.get("x-mekka-csrf-token") ?? "local-read-only-csrf-token";
      return service.handleAdminRequest(
        new Request(`${service.binding.issuer}/admin${path}${incoming.search}`, {
          method: request.method,
          headers,
          ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
        }),
        {
          capability: {
            tenant,
            actorId: "studio-local-admin",
            actions: ["auth:admin"],
            expiresAt: Date.now() + 60_000,
          },
          csrfToken,
        },
      );
    },
    verificationCode(email: string): string | null {
      const message = [...(localEmailSink?.messages ?? [])]
        .reverse()
        .find(
          (candidate) =>
            candidate.to.toLowerCase() === email.toLowerCase() &&
            candidate.purpose === "email-verification",
        );
      return message?.text.match(/\b\d{6}\b/)?.[0] ?? null;
    },
    close(): void {
      service.close();
    },
  });
}

function createResendEmailProvider(): AuthEmailProvider {
  const apiKey = process.env.MEKKA_RESEND_API_KEY?.trim() ?? "";
  const from = process.env.MEKKA_AUTH_EMAIL_FROM?.trim() ?? "";
  const apiUrl = process.env.MEKKA_RESEND_API_URL?.trim() || "https://api.resend.com/emails";

  return Object.freeze({
    async send(message): Promise<void> {
      if (apiKey.length === 0 || from.length === 0) {
        throw new Error(
          "Email delivery is not configured. Set MEKKA_RESEND_API_KEY and MEKKA_AUTH_EMAIL_FROM.",
        );
      }
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": createHash("sha256")
            .update(`${message.purpose}\0${message.to}\0${message.text}`)
            .digest("hex"),
          "user-agent": "mekka-auth/0.1",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Email provider rejected the request with status ${response.status}.`);
      }
    },
  });
}

async function loadSigningKeySet(file: string): Promise<AuthSigningKeySet> {
  const existing = await readJson<AuthSigningKeySet | null>(file, null);
  if (existing !== null) return existing;
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const created = Object.freeze({
    current: Object.freeze({
      kid: "local-signing-key-0001",
      privateKeyPkcs8: await exportPKCS8(privateKey),
      publicKeyJwk: await exportJWK(publicKey),
    }),
  });
  await writeFile(file, JSON.stringify(created, null, 2), "utf8");
  return created;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
