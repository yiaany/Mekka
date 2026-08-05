import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFormatVersion } from "@mekka/policy-engine";
import {
  createTenantContext,
  ProtocolError,
  type TenantContext,
  type TenantIdentity,
  tenantHeaders,
} from "@mekka/protocol";
import {
  createLocalObjectProvider,
  createObjectStorageCore,
  type ObjectProvider,
  type ObjectStorageCore,
  openStorageAdapter,
  type StorageAdapter,
} from "@mekka/storage-core";
import { createStudioStorageClient } from "../../../packages/studio-domain-sdk/src/index";
import {
  createGatewayApp,
  type GatewayMetric,
  type RestProject,
  type StorageAuditEvent,
} from "../src/app";

const temporaryDirectories: string[] = [];
const fixtures: StorageFixture[] = [];
const correlationId = "018e6c28-0000-7000-8000-000000000022";

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => removeTemporaryDirectory(directory)),
  );
});

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 1, retryDelay: 25 });
      return;
    } catch (error) {
      if (attempt === 59) {
        throw error;
      }
      await Bun.sleep(50);
    }
  }
}

describe("storage gateway", () => {
  test("supports the Studio SDK bucket and file lifecycle end to end", async () => {
    const fixture = await createFixture();
    const client = createStudioStorageClient({
      baseUrl: "http://gateway.local/storage/v1",
      tenant: mainTenant,
      getCredential: () => ({ kind: "session", token: "main-alice" }),
      getCsrfToken: () => "studio-storage-csrf-token-001",
      fetch: (input, init) => fixture.app.handle(new Request(input, init)),
    });

    await client.createBucket("studio-files", "studio-bucket-create-001");
    await client.uploadObject(
      "studio-files",
      "docs/<release>.txt",
      new Blob(["release"], { type: "text/plain" }),
      { idempotencyKey: "studio-object-upload-001" },
    );
    expect(await client.listBuckets({ search: "studio" })).toMatchObject([
      { name: "studio-files", isPublic: false },
    ]);
    expect(await client.listObjects("studio-files", { prefix: "docs" })).toMatchObject([
      { path: "docs/<release>.txt", size: 7 },
    ]);
    expect(await client.createSignedDownload("studio-files", "docs/<release>.txt")).toMatchObject({
      signedUrl: expect.stringContaining("storage.example.test"),
    });
    await client.deleteObject("studio-files", "docs/<release>.txt", "studio-object-delete-001");
    await client.deleteBucket("studio-files", "studio-bucket-delete-001");
    expect(await client.listBuckets({ search: "studio" })).toEqual([]);
  });

  test("manages buckets, lists objects and returns an effective policy summary with audit", async () => {
    const fixture = await createFixture();
    const created = await fixture.app.handle(
      storageRequest("/storage/v1/buckets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "bucket-create-001" },
        body: JSON.stringify({ name: "documents", isPublic: false }),
      }),
    );
    expect(created.status).toBe(201);
    const listed = await fixture.app.handle(storageRequest("/storage/v1/buckets?search=doc"));
    expect(await listed.json()).toMatchObject({
      buckets: [{ name: "documents", isPublic: false }],
    });
    await put(fixture, "folder/report.txt", bytes("report"), "bucket-list-object-001");
    const objects = await fixture.app.handle(
      storageRequest("/storage/v1/buckets/assets/objects?prefix=folder"),
    );
    expect(await objects.json()).toMatchObject({
      objects: [{ bucketName: "assets", path: "folder/report.txt" }],
    });
    const summary = await fixture.app.handle(
      storageRequest("/storage/v1/buckets/assets/policy-summary"),
    );
    expect(await summary.json()).toEqual({
      bucketName: "assets",
      canUpdateBucket: true,
      canDeleteBucket: true,
      canListObjects: true,
      canCreateObjects: true,
      canReadObjects: true,
      canDeleteObjects: true,
    });
    expect(fixture.auditEvents).toContainEqual(
      expect.objectContaining({ action: "storage.bucket.create", bucketName: "documents" }),
    );
    expect(fixture.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "storage.object.create",
        bucketName: "assets",
        objectPathHash: createHash("sha256").update("folder/report.txt").digest("hex"),
      }),
    );
    expect(JSON.stringify(fixture.auditEvents)).not.toContain("report.txt");
  });

  test("denies Storage administration without a current tenant capability", async () => {
    const fixture = await createFixture();
    const denied = await fixture.app.handle(
      storageRequest("/storage/v1/buckets", {
        method: "POST",
        token: "main-bob",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "bucket-denied-001" },
        body: JSON.stringify({ name: "denied-bucket", isPublic: false }),
      }),
    );
    expect(denied.status).toBe(403);
    expect(fixture.auditEvents).toHaveLength(0);
  });

  test("uploads, reads and deletes objects idempotently with safe response headers", async () => {
    const fixture = await createFixture();
    const body = bytes("hello storage");
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      "Idempotency-Key": "put-object-retry-001",
    };

    const first = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt", {
        method: "PUT",
        headers,
        body,
      }),
    );
    const repeated = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt", {
        method: "PUT",
        headers,
        body,
      }),
    );

    expect(first.status).toBe(201);
    expect(repeated.status).toBe(201);
    const metadata = await first.json();
    expect(metadata).toMatchObject({
      bucketName: "assets",
      path: "docs/a.txt",
      size: body.byteLength,
      contentType: "text/plain; charset=utf-8",
    });
    expect(first.headers.get("etag")).toBe(`"${metadata.checksumSha256}"`);
    expect(first.headers.get("x-mekka-content-sha256")).toBe(metadata.checksumSha256);

    const get = await fixture.app.handle(storageRequest("/storage/v1/object/assets/docs/a.txt"));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(body);
    expect(get.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(get.headers.get("content-length")).toBe(String(body.byteLength));
    expect(get.headers.get("content-disposition")).toContain("attachment");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("cache-control")).toBe("private, must-revalidate");

    const notModified = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt", {
        headers: { "If-None-Match": get.headers.get("etag") ?? "" },
      }),
    );
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(fixture.providerGets).toBe(1);

    const deleted = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt", {
        method: "DELETE",
        headers: { "Idempotency-Key": "delete-object-retry-001" },
      }),
    );
    const repeatedDelete = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt", {
        method: "DELETE",
        headers: { "Idempotency-Key": "delete-object-retry-001" },
      }),
    );
    expect(deleted.status).toBe(204);
    expect(repeatedDelete.status).toBe(204);
    const missing = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/docs/a.txt"),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("validation");
    expect(fixture.metrics.every((metric) => metric.rowCount === 0)).toBe(true);
  });

  test("preserves auth order and rejects policy denial, cross-tenant and traversal", async () => {
    const fixture = await createFixture();
    fixture.policyAllowed = false;
    const denied = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/denied.txt", {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": "policy-denied-001",
        },
        body: bytes("denied"),
      }),
    );
    expect(denied.status).toBe(403);

    fixture.policyAllowed = true;
    const crossTenant = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/cross.txt", {
        method: "PUT",
        token: "main-alice",
        tenant: otherTenant,
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": "cross-tenant-put-001",
        },
        body: bytes("cross"),
      }),
    );
    expect(crossTenant.status).toBe(403);

    const traversal = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/safe/%252e%252e/escape.txt", {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain",
          "Idempotency-Key": "traversal-put-001",
        },
        body: bytes("escape"),
      }),
    );
    expect(traversal.status).toBe(400);

    const noAuth = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/no-auth.txt", {
        token: "invalid",
      }),
    );
    expect(noAuth.status).toBe(401);
    expect(await noAuth.json()).toEqual({
      error: {
        code: "auth",
        message: "Authentication is required.",
        correlationId,
      },
    });

    const malformedTenantWithoutAuth = await fixture.app.handle(
      new Request("http://gateway.local/storage/v1/object/assets/no-auth.txt", {
        headers: { authorization: "Bearer invalid", "x-mekka-generation": "malformed" },
      }),
    );
    expect(malformedTenantWithoutAuth.status).toBe(401);

    const missingTenantWithoutAuth = await fixture.app.handle(
      new Request("http://gateway.local/storage/v1/object/assets/no-auth.txt", {
        headers: { authorization: "Bearer invalid" },
      }),
    );
    expect(missingTenantWithoutAuth.status).toBe(401);
  });

  test("returns 400 for oversized standard and resumable object paths", async () => {
    const fixture = await createFixture();
    const longSegment = "a".repeat(181);
    const longPath = ["a".repeat(128), "b".repeat(128), "c".repeat(128)].join("/");

    const standard = await put(fixture, longSegment, bytes("body"), "gateway-long-put-001");
    const resumable = await createUpload(fixture, longPath, 4, "gateway-long-upload-001");

    expect(standard.status).toBe(400);
    expect(resumable.status).toBe(400);
  });

  test("enforces preflight and streaming byte caps, checksums and MIME matching", async () => {
    const fixture = await createFixture({ maxObjectBytes: 4 });
    const common = {
      "Content-Type": "application/octet-stream",
      "Idempotency-Key": "object-size-limit-001",
    };
    const preflight = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/preflight.bin", {
        method: "PUT",
        headers: { ...common, "Content-Length": "5" },
        body: bytes("abcde"),
      }),
    );
    expect(preflight.status).toBe(413);

    const streaming = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/stream.bin", {
        method: "PUT",
        headers: { ...common, "Idempotency-Key": "stream-size-limit-001" },
        body: stream(bytes("abc"), bytes("de")),
      }),
    );
    expect(streaming.status).toBe(413);

    const lengthMismatch = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/length-mismatch.bin", {
        method: "PUT",
        headers: {
          ...common,
          "Content-Length": "3",
          "Idempotency-Key": "length-mismatch-001",
        },
        body: stream(bytes("ab")),
      }),
    );
    expect(lengthMismatch.status).toBe(400);

    const checksum = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/checksum.bin", {
        method: "PUT",
        headers: {
          ...common,
          "Idempotency-Key": "checksum-mismatch-001",
          "X-Mekka-Content-SHA256": "0".repeat(64),
        },
        body: bytes("abcd"),
      }),
    );
    expect(checksum.status).toBe(400);

    const malformedChecksum = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/checksum-format.bin", {
        method: "PUT",
        headers: {
          ...common,
          "Idempotency-Key": "checksum-format-001",
          "X-Mekka-Content-SHA256": "A".repeat(64),
        },
        body: bytes("abcd"),
      }),
    );
    expect(malformedChecksum.status).toBe(400);

    const mimeSpoof = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/spoof.json", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "mime-spoof-json-001",
        },
        body: new Uint8Array([0xff, 0xd8, 0xff]),
      }),
    );
    expect(mimeSpoof.status).toBe(400);
  });

  test("issues origin-pinned signed URLs and rejects expiry, tampering and wrong binding", async () => {
    const fixture = await createFixture();
    await put(fixture, "signed/report%20final.txt", bytes("signed body"), "signed-object-put-001");
    const sign = await fixture.app.handle(
      storageRequest("/storage/v1/object/sign/assets/signed/report%20final.txt", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: "attacker.invalid" },
        body: JSON.stringify({ expiresIn: 60 }),
      }),
    );
    expect(sign.status).toBe(200);
    const signed = await sign.json();
    const signedUrl = new URL(signed.signedUrl);
    expect(signedUrl.origin).toBe("https://storage.example.test");
    expect(signedUrl.host).not.toBe("attacker.invalid");
    expect(signedUrl.searchParams.get("organizationId")).toBe(mainTenant.organizationId);
    expect(signedUrl.searchParams.get("projectId")).toBe(mainTenant.projectId);

    const redeemed = await fixture.app.handle(new Request(signedUrl));
    expect(redeemed.status).toBe(200);
    expect(await redeemed.text()).toBe("signed body");
    expect(redeemed.headers.get("cache-control")).toBe("public, max-age=60, immutable");
    const providerGets = fixture.providerGets;
    const signedNotModified = await fixture.app.handle(
      new Request(signedUrl, { headers: { "If-None-Match": redeemed.headers.get("etag") ?? "" } }),
    );
    expect(signedNotModified.status).toBe(304);
    expect(fixture.providerGets).toBe(providerGets);

    const tampered = new URL(signedUrl);
    const token = tampered.searchParams.get("token") ?? "";
    tampered.searchParams.set("token", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`);
    expect((await fixture.app.handle(new Request(tampered))).status).toBe(403);

    const wrongPath = new URL(signedUrl);
    wrongPath.pathname = "/storage/v1/signed/assets/signed/wrong.txt";
    expect((await fixture.app.handle(new Request(wrongPath))).status).toBe(403);

    const wrongProject = new URL(signedUrl);
    wrongProject.searchParams.set("projectId", otherTenant.projectId);
    expect((await fixture.app.handle(new Request(wrongProject))).status).toBe(403);

    fixture.clock += 60_000;
    expect((await fixture.app.handle(new Request(signedUrl))).status).toBe(403);
  });

  test("rate limits signed requests before tenant parsing and project resolution", async () => {
    const fixture = await createFixture();
    fixture.signedRateAllowed = false;
    const malformed = new Request(
      "http://gateway.local/storage/v1/signed/assets/file.bin?organizationId=victim",
    );
    const response = await fixture.app.handle(malformed);

    expect(response.status).toBe(429);
    expect(fixture.signedRateRequests).toEqual([malformed]);
    expect(fixture.signedProjectResolutions).toBe(0);
  });

  test("resumes sequential uploads, enforces ownership and finalizes safely", async () => {
    const fixture = await createFixture({ maxStorageChunkBytes: 3 });
    const create = await createUpload(fixture, "uploads/resume.bin", 6, "resume-upload-key-001");
    expect(create.status).toBe(201);
    expect(create.headers.get("upload-offset")).toBe("0");
    expect(create.headers.get("upload-length")).toBe("6");
    expect(create.headers.get("tus-resumable")).toBe("1.0.0");
    expect(new URL(create.headers.get("location") ?? "").origin).toBe(
      "https://storage.example.test",
    );
    fixture.clock += 1_000;
    const retriedCreate = await createUpload(
      fixture,
      "uploads/resume.bin",
      6,
      "resume-upload-key-001",
    );
    expect(retriedCreate.status).toBe(201);
    expect(retriedCreate.headers.get("location")).toBe(create.headers.get("location"));
    const uploadId = new URL(create.headers.get("location") ?? "").pathname.split("/").at(-1);
    expect(uploadId).toBeDefined();

    const firstChunk = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "0",
        },
        body: bytes("abc"),
      }),
    );
    expect(firstChunk.status).toBe(204);
    expect(firstChunk.headers.get("upload-offset")).toBe("3");

    const head = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "HEAD",
        headers: { "Tus-Resumable": "1.0.0" },
      }),
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("upload-offset")).toBe("3");

    const wrongOffset = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "2",
        },
        body: bytes("def"),
      }),
    );
    expect(wrongOffset.status).toBe(409);

    const otherActor = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "HEAD",
        token: "main-bob",
        headers: { "Tus-Resumable": "1.0.0" },
      }),
    );
    expect(otherActor.status).toBe(404);

    const otherProject = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "HEAD",
        token: "other-alice",
        tenant: otherTenant,
        headers: { "Tus-Resumable": "1.0.0" },
      }),
    );
    expect(otherProject.status).toBe(404);

    const oversized = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "3",
        },
        body: bytes("defg"),
      }),
    );
    expect(oversized.status).toBe(413);

    const finalized = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "3",
        },
        body: bytes("def"),
      }),
    );
    expect(finalized.status).toBe(204);
    expect(finalized.headers.get("upload-offset")).toBe("6");
    expect(finalized.headers.get("etag")).not.toBeNull();
    expect(finalized.headers.get("x-mekka-content-sha256")).toBe(
      createHash("sha256").update("abcdef").digest("hex"),
    );
    const object = await fixture.app.handle(
      storageRequest("/storage/v1/object/assets/uploads/resume.bin"),
    );
    expect(await object.text()).toBe("abcdef");
  });

  test("aborts repeatedly and cleans expired sessions opportunistically", async () => {
    const fixture = await createFixture({ resumableUploadTtlMs: 100 });
    const first = await createUpload(fixture, "uploads/expired.bin", 1, "expired-upload-key-001");
    const firstId = new URL(first.headers.get("location") ?? "").pathname.split("/").at(-1);
    fixture.clock += 100;
    await createUpload(fixture, "uploads/next.bin", 1, "next-upload-key-001");
    const expired = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${firstId}`, {
        method: "HEAD",
        headers: { "Tus-Resumable": "1.0.0" },
      }),
    );
    expect(expired.status).toBe(404);

    const active = await createUpload(fixture, "uploads/abort.bin", 1, "abort-upload-key-001");
    const activeId = new URL(active.headers.get("location") ?? "").pathname.split("/").at(-1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const aborted = await fixture.app.handle(
        storageRequest(`/storage/v1/resumable/${activeId}`, {
          method: "DELETE",
          headers: { "Tus-Resumable": "1.0.0" },
        }),
      );
      expect(aborted.status).toBe(204);
    }
  });

  test("returns 409 when abort races with finalizing provider write", async () => {
    const fixture = await createFixture({ delayMainProviderPut: true });
    const create = await createUpload(fixture, "uploads/race.bin", 3, "race-upload-key-001");
    const uploadId = new URL(create.headers.get("location") ?? "").pathname.split("/").at(-1);
    const finalPatch = fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": "0",
        },
        body: bytes("one"),
      }),
    );
    await fixture.delayedProvider?.entered;

    const abort = await fixture.app.handle(
      storageRequest(`/storage/v1/resumable/${uploadId}`, {
        method: "DELETE",
        headers: { "Tus-Resumable": "1.0.0" },
      }),
    );
    expect(abort.status).toBe(409);

    fixture.delayedProvider?.release();
    expect((await finalPatch).status).toBe(204);
    expect(
      await (
        await fixture.app.handle(storageRequest("/storage/v1/object/assets/uploads/race.bin"))
      ).text(),
    ).toBe("one");
  });
});

type StorageFixture = Readonly<{
  app: ReturnType<typeof createGatewayApp>;
  metrics: GatewayMetric[];
  auditEvents: StorageAuditEvent[];
  projects: ReadonlyMap<string, RestProject>;
  delayedProvider: DelayedGatewayPutProvider | null;
  signedRateRequests: Request[];
  close(): void;
}> & {
  clock: number;
  policyAllowed: boolean;
  providerGets: number;
  signedRateAllowed: boolean;
  signedProjectResolutions: number;
};

async function createFixture(
  options: Partial<
    Readonly<{
      maxObjectBytes: number;
      maxStorageChunkBytes: number;
      maxSignedUrlTtlSeconds: number;
      resumableUploadTtlMs: number;
      delayMainProviderPut: boolean;
    }>
  > = {},
): Promise<StorageFixture> {
  const { delayMainProviderPut = false, ...limits } = options;
  const fixture = {
    clock: 1_000_000,
    policyAllowed: true,
    metrics: [] as GatewayMetric[],
    auditEvents: [] as StorageAuditEvent[],
    providerGets: 0,
    signedRateAllowed: true,
    signedRateRequests: [] as Request[],
    signedProjectResolutions: 0,
  };
  const resources = await Promise.all([
    createProjectResources(
      mainTenant,
      () => fixture.clock,
      () => fixture.policyAllowed,
      () => {
        fixture.providerGets += 1;
      },
      delayMainProviderPut,
    ),
    createProjectResources(
      otherTenant,
      () => fixture.clock,
      () => fixture.policyAllowed,
      () => {},
      false,
    ),
  ]);
  const projects = new Map(
    resources.map((resource) => [resource.project.tenant.projectId, resource.project]),
  );
  const contexts = new Map<string, TenantContext>([
    ["main-alice", context(mainTenant, "alice", "user", true)],
    ["main-bob", context(mainTenant, "bob")],
    ["other-alice", context(otherTenant, "alice")],
  ]);
  const app = createGatewayApp({
    authenticate: (request) => {
      const authorization = request.headers.get("authorization");
      const context = authorization?.startsWith("Bearer ")
        ? contexts.get(authorization.slice("Bearer ".length))
        : undefined;
      if (context === undefined) {
        throw new ProtocolError("auth");
      }
      return context;
    },
    resolveProject: (tenantContext) => requireProject(projects, tenantContext.tenant),
    resolveProjectByTenant: (tenant) => {
      fixture.signedProjectResolutions += 1;
      return requireProject(projects, tenant);
    },
    consumeRateLimit: () => true,
    consumeSignedRateLimit: (request) => {
      fixture.signedRateRequests.push(request);
      return fixture.signedRateAllowed;
    },
    storagePublicOrigin: "https://storage.example.test",
    recordMetric: (metric) => fixture.metrics.push(metric),
    recordStorageAudit: (event) => fixture.auditEvents.push(event),
    now: () => fixture.clock,
    limits,
  });
  const result = Object.assign(fixture, {
    app,
    delayedProvider: resources[0]?.delayedProvider ?? null,
    projects,
    close() {
      for (const resource of resources) {
        resource.provider.close();
        resource.adapter.close();
      }
    },
  });
  fixtures.push(result);
  return result;
}

async function createProjectResources(
  tenant: TenantIdentity,
  now: () => number,
  policyAllowed: () => boolean,
  onProviderGet: () => void,
  delayProviderPut: boolean,
): Promise<
  Readonly<{
    adapter: StorageAdapter;
    provider: ObjectProvider;
    delayedProvider: DelayedGatewayPutProvider | null;
    objectStorage: ObjectStorageCore;
    project: RestProject;
  }>
> {
  const directory = await mkdtemp(join(tmpdir(), "mekka-gateway-storage-"));
  temporaryDirectories.push(directory);
  const adapter = openStorageAdapter({
    databaseDirectory: directory,
    databasePath: join(directory, "metadata.sqlite"),
  });
  const localProvider = createLocalObjectProvider(join(directory, "objects"));
  const countingProvider = new CountingGetProvider(localProvider, onProviderGet);
  const delayedProvider = delayProviderPut ? new DelayedGatewayPutProvider(countingProvider) : null;
  const provider = delayedProvider ?? countingProvider;
  const objectStorage = createObjectStorageCore({
    metadata: adapter,
    provider,
    policy: { authorize: () => policyAllowed() },
    maxObjectBytes: 1024 * 1024,
    maxUploadChunkBytes: 1024 * 1024,
    signedReadGrants: {
      current: {
        id: "gateway-storage-test",
        secret: bytes("0123456789abcdef0123456789abcdef"),
      },
    },
    now,
  });
  const tenantContext = context(tenant, "setup-service", "service");
  await objectStorage.createBucket(tenantContext, { name: "assets" });
  const project: RestProject = Object.freeze({
    tenant,
    storage: adapter,
    objectStorage,
    executor: { execute: (statement) => adapter.execute(statement) },
    policies: { formatVersion: policyFormatVersion, tables: [] },
  });
  return Object.freeze({ adapter, provider, delayedProvider, objectStorage, project });
}

class CountingGetProvider implements ObjectProvider {
  constructor(
    private readonly delegate: ObjectProvider,
    private readonly onGet: () => void,
  ) {}

  put(request: Parameters<ObjectProvider["put"]>[0]) {
    return this.delegate.put(request);
  }

  get(key: string, maxBytes: number) {
    this.onGet();
    return this.delegate.get(key, maxBytes);
  }

  head(key: string) {
    return this.delegate.head(key);
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }

  close(): void {
    this.delegate.close();
  }
}

class DelayedGatewayPutProvider implements ObjectProvider {
  readonly entered: Promise<void>;
  private resolveEntered: (() => void) | undefined;
  private resolveRelease: (() => void) | undefined;
  private readonly released: Promise<void>;

  constructor(private readonly delegate: ObjectProvider) {
    this.entered = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
    this.released = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  async put(request: Parameters<ObjectProvider["put"]>[0]) {
    this.resolveEntered?.();
    await this.released;
    return this.delegate.put(request);
  }

  release(): void {
    this.resolveRelease?.();
  }

  get(key: string, maxBytes: number) {
    return this.delegate.get(key, maxBytes);
  }

  head(key: string) {
    return this.delegate.head(key);
  }

  delete(key: string) {
    return this.delegate.delete(key);
  }

  list(prefix: string) {
    return this.delegate.list(prefix);
  }

  close(): void {
    this.release();
    this.delegate.close();
  }
}

function requireProject(
  projects: ReadonlyMap<string, RestProject>,
  tenant: TenantIdentity,
): RestProject {
  const project = projects.get(tenant.projectId);
  if (project === undefined) {
    throw new Error("Project not found.");
  }
  return project;
}

async function put(
  fixture: StorageFixture,
  path: string,
  body: Uint8Array,
  idempotencyKey: string,
): Promise<Response> {
  return fixture.app.handle(
    storageRequest(`/storage/v1/object/assets/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": idempotencyKey },
      body,
    }),
  );
}

function createUpload(
  fixture: StorageFixture,
  path: string,
  length: number,
  idempotencyKey: string,
): Promise<Response> {
  return fixture.app.handle(
    storageRequest(`/storage/v1/resumable/assets/${path}`, {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(length),
        "Upload-Metadata": `contentType ${Buffer.from("application/octet-stream").toString("base64")}`,
      },
    }),
  );
}

function storageRequest(
  path: string,
  options: Readonly<{
    method?: string;
    token?: string;
    tenant?: TenantIdentity;
    headers?: Readonly<Record<string, string>>;
    body?: BodyInit | null;
  }> = {},
): Request {
  const tenant = options.tenant ?? mainTenant;
  return new Request(`http://gateway.local${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.token ?? "main-alice"}`,
      [tenantHeaders.organizationId]: tenant.organizationId,
      [tenantHeaders.projectId]: tenant.projectId,
      [tenantHeaders.environmentId]: tenant.environmentId,
      [tenantHeaders.branchId]: tenant.branchId,
      [tenantHeaders.generation]: String(tenant.generation),
      [tenantHeaders.correlationId]: correlationId,
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function stream(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function context(
  tenant: TenantIdentity,
  actorId: string,
  actorKind: "user" | "service" = "user",
  isStorageAdmin = false,
): TenantContext {
  return createTenantContext({
    tenant,
    actor: { kind: actorKind, id: actorId },
    capabilities: isStorageAdmin
      ? [
          {
            id: "storage-admin-capability",
            tenant,
            actions: ["storage:admin"],
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
        ]
      : [],
    correlationId,
  });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const mainTenant = createTenantContext({
  tenant: {
    organizationId: "org-main",
    projectId: "project-main",
    environmentId: "environment-main",
    branchId: "branch-main",
    generation: 1,
  },
  actor: { kind: "service", id: "tenant-builder" },
  capabilities: [],
  correlationId,
}).tenant;

const otherTenant = createTenantContext({
  tenant: {
    organizationId: "org-main",
    projectId: "project-other",
    environmentId: "environment-main",
    branchId: "branch-main",
    generation: 1,
  },
  actor: { kind: "service", id: "tenant-builder" },
  capabilities: [],
  correlationId,
}).tenant;
