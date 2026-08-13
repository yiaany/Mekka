import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  createTenantContext,
  parseCorrelationId,
  parseTenantIdentity,
  type TenantContext,
} from "@mekka/protocol";
import {
  createLocalObjectProvider,
  createObjectStorageCore,
  normalizeStorageObjectPath,
  type ObjectProvider,
  ObjectProviderError,
  type ObjectProviderGetResult,
  type ObjectProviderMetadata,
  type ObjectProviderPutRequest,
  openStorageAdapter,
  type StorageAdapter,
  StorageAdapterError,
  StorageCoreError,
  type StoragePolicyHook,
  type StoragePolicyRequest,
  storageMetadataSchemaVersion,
  storageObjectPathMaxUtf8Bytes,
  storageObjectPathSegmentMaxUtf8Bytes,
} from "../src/index";
import { createS3ObjectProvider } from "../src/s3-object-provider";

const temporaryDirectories: string[] = [];
const allowAllPolicy: StoragePolicyHook = Object.freeze({ authorize: () => true });

afterEach(async () => {
  await Bun.sleep(25);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { force: true, recursive: true, maxRetries: 5, retryDelay: 20 }),
      ),
  );
});

describe("object provider contract", () => {
  test("local provider implements idempotent put/head/list/delete and rejects traversal", async () => {
    const directory = await temporaryDirectory("mekka-object-local-");
    const provider = createLocalObjectProvider(directory);
    await runProviderContract(provider);

    await expect(
      provider.put(requestFor("../escape.txt", "escape", "local-traversal")),
    ).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID", retryable: false });
    await expect(
      provider.put(
        requestFor(`malformed/${String.fromCharCode(0xd800)}`, "invalid", "local-surrogate"),
      ),
    ).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID", retryable: false });

    const driveRelative = requestFor("windows/a/C:/b", "drive-relative", "windows-key-001");
    const ordinary = requestFor("windows/a/b", "ordinary", "windows-key-002");
    await provider.put(driveRelative);
    await provider.put(ordinary);
    await provider.put(requestFor("windows/CON", "reserved", "windows-key-003"));
    await provider.put(requestFor("windows/name.", "trailing-dot", "windows-key-004"));
    await provider.put(requestFor("windows/name ", "trailing-space", "windows-key-005"));
    expect(await provider.head(driveRelative.key)).toMatchObject({
      checksumSha256: driveRelative.checksumSha256,
    });
    expect(await provider.head(ordinary.key)).toMatchObject({
      checksumSha256: ordinary.checksumSha256,
    });

    const left = requestFor("race/same.txt", "left", "race-put-left");
    const right = requestFor("race/same.txt", "right", "race-put-right");
    const results = await Promise.allSettled([provider.put(left), provider.put(right)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    provider.close();
  });

  test("S3 provider implements the same object contract", async () => {
    const fake = new FakeS3Client();
    const provider = createS3ObjectProvider({
      bucket: "physical-bucket",
      client: fake as unknown as S3Client,
    });

    await runProviderContract(provider);
    provider.close();
  });

  test("S3 provider verifies downloaded bytes instead of trusting checksum metadata", async () => {
    const fake = new FakeS3Client();
    const provider = createS3ObjectProvider({
      bucket: "physical-bucket",
      client: fake as unknown as S3Client,
    });
    const request = requestFor("tenant/bucket/corrupt.txt", "original", "provider-corrupt-001");
    await provider.put(request);
    fake.corrupt(request.key, bytes("modified"));

    await expect(provider.get(request.key, 100)).rejects.toMatchObject({
      code: "OBJECT_PROVIDER_INVALID",
      retryable: false,
    });
  });

  test("S3 provider rejects a caller checksum that does not match the body", async () => {
    const provider = createS3ObjectProvider({
      bucket: "physical-bucket",
      client: new FakeS3Client() as unknown as S3Client,
    });
    const request = requestFor("tenant/bucket/mismatch.txt", "actual", "provider-mismatch-001");

    await expect(
      provider.put({ ...request, checksumSha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID", retryable: false });
  });

  test("S3 provider rejects oversized UTF-8 keys before an SDK call", async () => {
    const fake = new FakeS3Client();
    const provider = createS3ObjectProvider({
      bucket: "physical-bucket",
      client: fake as unknown as S3Client,
    });
    const key = "a".repeat(1_025);

    await expect(
      provider.put(requestFor(key, "body", "provider-long-put-001")),
    ).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID", retryable: false });
    await expect(provider.head(key)).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID" });
    await expect(provider.get(key, 4)).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID" });
    await expect(provider.delete(key)).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID" });
    await expect(provider.list(key)).rejects.toMatchObject({ code: "OBJECT_PROVIDER_INVALID" });
    expect(fake.sendCalls).toBe(0);
  });
});

describe("Storage core", () => {
  test("isolates buckets and physical keys by the complete tenant tuple", async () => {
    const fixture = await createFixture();
    try {
      const tenantA = context("project-one", 1);
      const tenantB = context("project-two", 1);
      const tenantGenerationTwo = context("project-one", 2);
      await fixture.core.createBucket(tenantA, { name: "assets" });
      await fixture.core.putObject(tenantA, {
        bucketName: "assets",
        path: "avatars/user.txt",
        body: bytes("tenant-a"),
        contentType: "text/plain",
        idempotencyKey: "put-tenant-a-001",
      });

      expect(await fixture.core.listBuckets(tenantB)).toEqual([]);
      expect(await fixture.core.listBuckets(tenantGenerationTwo)).toEqual([]);
      await expect(fixture.core.getBucket(tenantB, "assets")).rejects.toMatchObject({
        code: "STORAGE_CORE_NOT_FOUND",
      });
      const stored = await fixture.provider.list("");
      expect(stored).toHaveLength(1);
      expect(stored[0]?.key).toContain(
        "/projects/project-one/environments/env-main/branches/branch-main/generations/1/",
      );
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("denies by default and rejects unsafe bucket and object paths", async () => {
    const fixture = await createFixture(false);
    try {
      const tenant = context("project-one", 1);
      await expect(fixture.core.createBucket(tenant, { name: "assets" })).rejects.toMatchObject({
        code: "STORAGE_CORE_FORBIDDEN",
      });

      const permitted = createObjectStorageCore({
        metadata: fixture.metadata,
        provider: fixture.provider,
        policy: allowAllPolicy,
      });
      await expect(permitted.createBucket(tenant, { name: "../assets" })).rejects.toMatchObject({
        code: "STORAGE_CORE_VALIDATION",
      });
      await expect(
        permitted.createBucket(tenant, {
          name: "invalid-public",
          isPublic: "yes" as unknown as boolean,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      await permitted.createBucket(tenant, { name: "assets" });
      await expect(
        permitted.putObject(tenant, {
          bucketName: "assets",
          path: "../secret.txt",
          body: bytes("no"),
          contentType: "text/plain",
          idempotencyKey: "put-traversal-001",
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("rejects oversized object paths before metadata reservation or provider calls", async () => {
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = new CountingProvider();
    const core = createObjectStorageCore({ metadata, provider, policy: allowAllPolicy });
    const tenant = context("project-one", 1);
    const longSegment = "a".repeat(storageObjectPathSegmentMaxUtf8Bytes + 1);
    const longPath = ["a".repeat(128), "b".repeat(128), "c".repeat(128)].join("/");
    expect(
      normalizeStorageObjectPath("a".repeat(storageObjectPathSegmentMaxUtf8Bytes)),
    ).toHaveLength(storageObjectPathSegmentMaxUtf8Bytes);
    expect(() => normalizeStorageObjectPath("é".repeat(91))).toThrow(StorageCoreError);
    expect(bytes(longPath).byteLength).toBeGreaterThan(storageObjectPathMaxUtf8Bytes);

    try {
      await core.createBucket(tenant, { name: "assets" });
      for (const [path, idempotencyKey] of [
        [longSegment, "put-long-segment-001"],
        [longPath, "put-long-full-path-001"],
      ] as const) {
        await expect(
          core.putObject(tenant, {
            bucketName: "assets",
            path,
            body: bytes("body"),
            contentType: "text/plain",
            idempotencyKey,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      }
      for (const [path, idempotencyKey] of [
        [longSegment, "upload-long-segment-001"],
        [longPath, "upload-long-full-path-001"],
      ] as const) {
        await expect(
          core.createResumableUpload(tenant, {
            bucketName: "assets",
            path,
            uploadLength: 4,
            contentType: "application/octet-stream",
            idempotencyKey,
            expiresAt: 2_000,
          }),
        ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      }

      expect(
        metadata.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM storage_objects",
        }).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        metadata.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM storage_uploads",
        }).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        metadata.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM storage_objects WHERE state = 'pending_put'",
        }).rows,
      ).toEqual([{ count: 0 }]);
      expect(
        metadata.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM storage_uploads WHERE state = 'finalizing'",
        }).rows,
      ).toEqual([{ count: 0 }]);
      expect(provider.calls).toBe(0);
    } finally {
      metadata.close();
    }
  });

  test("publishes metadata only after provider success and reconciles ambiguous puts", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    await fixture.core.createBucket(tenant, { name: "assets" });
    const ambiguousProvider = new AmbiguousPutProvider(fixture.provider);
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: ambiguousProvider,
      policy: allowAllPolicy,
    });

    try {
      await expect(
        core.putObject(tenant, {
          bucketName: "assets",
          path: "docs/readme.txt",
          body: bytes("stored before timeout"),
          contentType: "text/plain",
          idempotencyKey: "put-ambiguous-001",
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_INFRASTRUCTURE", retryable: true });
      await expect(
        core.getObjectMetadata(tenant, "assets", "docs/readme.txt"),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_NOT_FOUND" });

      const report = await core.reconcileBucket(tenant, "assets");
      expect(report).toMatchObject({ completedPuts: 1, completedDeletes: 0, issues: [] });
      expect(await core.getObjectMetadata(tenant, "assets", "docs/readme.txt")).toMatchObject({
        path: "docs/readme.txt",
        size: 21,
      });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("keeps failed deletes pending, retries them, and reports provider orphans", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    await fixture.core.createBucket(tenant, { name: "assets" });
    await fixture.core.putObject(tenant, {
      bucketName: "assets",
      path: "delete-me.txt",
      body: bytes("delete"),
      contentType: "text/plain",
      idempotencyKey: "put-delete-001",
    });
    const failingProvider = new FailOnceDeleteProvider(fixture.provider);
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: failingProvider,
      policy: allowAllPolicy,
    });

    try {
      await expect(core.deleteObject(tenant, "assets", "delete-me.txt")).rejects.toMatchObject({
        code: "STORAGE_CORE_INFRASTRUCTURE",
        retryable: true,
      });
      await expect(core.getObjectMetadata(tenant, "assets", "delete-me.txt")).rejects.toMatchObject(
        {
          code: "STORAGE_CORE_NOT_FOUND",
        },
      );
      const orphanKey = `${providerBucketPrefix(tenant, "assets")}orphan/versions/orphan001`;
      await fixture.provider.put(requestFor(orphanKey, "orphan", "orphan-put-001"));

      const report = await core.reconcileBucket(tenant, "assets");
      expect(report.completedDeletes).toBe(1);
      expect(report.issues).toEqual([
        {
          kind: "orphan_provider_object",
          bucketName: "assets",
          objectPath: null,
          providerKey: orphanKey,
          retryable: false,
        },
      ]);
      await expect(core.deleteBucket(tenant, "assets")).rejects.toMatchObject({
        code: "STORAGE_CORE_CONFLICT",
      });
      await fixture.provider.delete(orphanKey);
      await core.deleteBucket(tenant, "assets");
      expect(await core.listBuckets(tenant)).toEqual([]);
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("makes retryable object creation idempotent and rejects key reuse", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    try {
      await fixture.core.createBucket(tenant, { name: "assets" });
      const input = {
        bucketName: "assets",
        path: "same.txt",
        body: bytes("same"),
        contentType: "text/plain",
        idempotencyKey: "put-idempotent-001",
      } as const;
      const [first, second] = await Promise.all([
        fixture.core.putObject(tenant, input),
        fixture.core.putObject(tenant, input),
      ]);
      expect(second).toEqual(first);
      await expect(
        fixture.core.putObject(tenant, { ...input, body: bytes("different") }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_CONFLICT" });
      await expect(
        fixture.core.putObject(tenant, {
          ...input,
          path: "other.txt",
          body: bytes("same"),
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_CONFLICT" });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("authorizes object reads and verifies persisted size and checksum", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    let allowRead = true;
    const actions: string[] = [];
    const policy: StoragePolicyHook = Object.freeze({
      authorize(request: StoragePolicyRequest) {
        actions.push(request.action);
        return request.action !== "object:read" || allowRead;
      },
    });
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: fixture.provider,
      policy,
      createVersion: () => "version-read-001",
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      await core.putObject(tenant, {
        bucketName: "assets",
        path: "read/me.txt",
        body: bytes("verified"),
        contentType: "text/plain",
        idempotencyKey: "put-read-object-001",
      });
      const object = await core.getObject(tenant, "assets", "read/me.txt");
      expect(new TextDecoder().decode(object.body)).toBe("verified");
      expect(actions.at(-1)).toBe("object:read");
      object.body.fill(0);
      expect(
        new TextDecoder().decode((await core.getObject(tenant, "assets", "read/me.txt")).body),
      ).toBe("verified");

      allowRead = false;
      await expect(core.getObject(tenant, "assets", "read/me.txt")).rejects.toMatchObject({
        code: "STORAGE_CORE_FORBIDDEN",
      });

      const corruptCore = createObjectStorageCore({
        metadata: fixture.metadata,
        provider: new CorruptReadProvider(fixture.provider),
        policy: allowAllPolicy,
      });
      await expect(corruptCore.getObject(tenant, "assets", "read/me.txt")).rejects.toMatchObject({
        code: "STORAGE_CORE_INFRASTRUCTURE",
      });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("issues and redeems read grants with expiry and exact claim binding", async () => {
    const directory = await temporaryDirectory("mekka-storage-grants-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    const secret = bytes("0123456789abcdef0123456789abcdef");
    let clock = 1_000;
    let allowRead = true;
    let readChecks = 0;
    const policy: StoragePolicyHook = Object.freeze({
      authorize(request: StoragePolicyRequest) {
        if (request.action === "object:read") {
          readChecks += 1;
          return allowRead;
        }
        return true;
      },
    });
    const core = createObjectStorageCore({
      metadata,
      provider,
      policy,
      now: () => clock,
      createVersion: () => "version-grant-001",
      signedReadGrants: { current: { id: "current", secret } },
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      await core.putObject(tenant, {
        bucketName: "assets",
        path: "signed/read.txt",
        body: bytes("signed"),
        contentType: "text/plain",
        idempotencyKey: "put-signed-read-001",
      });
      const token = await core.issueReadGrant(tenant, "assets", "signed/read.txt", 2_000);
      expect(readChecks).toBe(1);
      const grant = core.verifyReadGrant(token);
      allowRead = false;
      const target = {
        tenant: tenant.tenant,
        bucketName: "assets",
        path: "signed/read.txt",
        action: "object:read",
      } as const;
      expect(new TextDecoder().decode((await core.redeemReadGrant(grant, target)).body)).toBe(
        "signed",
      );
      expect(readChecks).toBe(1);
      const rotatedCore = createObjectStorageCore({
        metadata,
        provider,
        policy,
        now: () => clock,
        signedReadGrants: {
          current: { id: "next", secret: bytes("abcdef0123456789abcdef0123456789") },
          previous: { id: "current", secret },
        },
      });
      const rotatedGrant = rotatedCore.verifyReadGrant(token);
      expect(
        new TextDecoder().decode((await rotatedCore.redeemReadGrant(rotatedGrant, target)).body),
      ).toBe("signed");
      expect(readChecks).toBe(1);

      await expect(
        core.redeemReadGrant(grant, { ...target, path: "signed/wrong.txt" }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      await expect(
        core.redeemReadGrant(grant, { ...target, bucketName: "other-bucket" }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      await expect(
        core.redeemReadGrant(grant, {
          ...target,
          tenant: context("project-two", 1).tenant,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_VALIDATION" });
      const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
      expect(() => core.verifyReadGrant(tampered)).toThrow(/Signed grant is invalid/);
      const [payload, signature] = token.split(".");
      expect(() => core.verifyReadGrant(`.${signature}`)).toThrow(/Signed grant is invalid/);
      expect(() => core.verifyReadGrant(`${payload}.`)).toThrow(/Signed grant is invalid/);
      expect(() => core.verifyReadGrant(`${payload}=.${signature}`)).toThrow(
        /Signed grant is invalid/,
      );
      expect(() => core.verifyReadGrant(`${payload}.${signature}!`)).toThrow(
        /Signed grant is invalid/,
      );
      expect(() => core.verifyReadGrant(withTrailingBitAlias(token))).toThrow(
        /Signed grant is invalid/,
      );
      expect(() =>
        core.verifyReadGrant(rewriteGrant(token, secret, { action: "object:delete" })),
      ).toThrow(/Signed grant is invalid/);

      clock = 2_000;
      await expect(core.redeemReadGrant(grant, target)).rejects.toMatchObject({
        code: "STORAGE_CORE_VALIDATION",
      });
      expect(() => core.verifyReadGrant(token)).toThrow(/Signed grant is invalid/);
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("persists sequential resumable uploads and retries finalization safely", async () => {
    const directory = await temporaryDirectory("mekka-storage-resumable-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    const failingProvider = new FailOncePutProvider(provider);
    let clock = 1_000;
    const core = createObjectStorageCore({
      metadata,
      provider,
      policy: allowAllPolicy,
      now: () => clock,
      createVersion: () => "version-upload-001",
      createUploadId: () => "upload-session-001",
      maxUploadChunkBytes: 3,
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      const upload = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "uploads/file.txt",
        uploadLength: 6,
        contentType: "text/plain",
        idempotencyKey: "upload-resume-001",
        expiresAt: 2_000,
      });
      expect(upload).toMatchObject({ id: "upload-session-001", offset: 0, complete: false });
      expect(
        await core.createResumableUpload(tenant, {
          bucketName: "assets",
          path: "uploads/file.txt",
          uploadLength: 6,
          contentType: "text/plain",
          idempotencyKey: "upload-resume-001",
          expiresAt: 2_000,
        }),
      ).toEqual(upload);
      expect(await core.appendResumableUpload(tenant, upload.id, 0, bytes("abc"))).toMatchObject({
        upload: { offset: 3, complete: false },
        object: null,
      });
      expect(await core.getResumableUpload(tenant, upload.id)).toMatchObject({ offset: 3 });
      await expect(
        core.appendResumableUpload(tenant, upload.id, 2, bytes("def")),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_CONFLICT" });
      await expect(
        core.getResumableUpload(contextWithActor("project-one", 1, "other-user"), upload.id),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_NOT_FOUND" });
      await expect(
        core.getResumableUpload(context("project-two", 1), upload.id),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_NOT_FOUND" });

      const resumedCore = createObjectStorageCore({
        metadata,
        provider: failingProvider,
        policy: allowAllPolicy,
        now: () => clock,
        createVersion: () => "version-upload-001",
        maxUploadChunkBytes: 3,
      });
      await expect(
        resumedCore.appendResumableUpload(tenant, upload.id, 3, bytes("def")),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_INFRASTRUCTURE", retryable: true });
      const finalized = await resumedCore.appendResumableUpload(tenant, upload.id, 3, bytes("def"));
      expect(finalized).toMatchObject({
        upload: { offset: 6, complete: true },
        object: { path: "uploads/file.txt", size: 6 },
      });
      const retried = await resumedCore.appendResumableUpload(tenant, upload.id, 3, bytes("def"));
      expect(retried.object).toEqual(finalized.object);
      expect(
        new TextDecoder().decode((await core.getObject(tenant, "assets", "uploads/file.txt")).body),
      ).toBe("abcdef");

      clock = 2_000;
      expect(core.cleanupExpiredResumableUploads()).toBe(1);
      await expect(core.getResumableUpload(tenant, upload.id)).rejects.toMatchObject({
        code: "STORAGE_CORE_NOT_FOUND",
      });
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("recovers an expired resumable finalization lease when the provider object matches", async () => {
    const directory = await temporaryDirectory("mekka-storage-lease-recovery-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    const failingProvider = new FailOncePutProvider(provider);
    let clock = 1_000;
    const core = createObjectStorageCore({
      metadata,
      provider: failingProvider,
      policy: allowAllPolicy,
      now: () => clock,
      createVersion: () => "version-lease-001",
      createUploadId: () => "upload-lease-001",
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      const upload = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "leases/recovered.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-lease-recovered-001",
        expiresAt: 120_000,
      });
      await expect(
        core.appendResumableUpload(tenant, upload.id, 0, bytes("one")),
      ).rejects.toMatchObject({
        code: "STORAGE_CORE_INFRASTRUCTURE",
        retryable: true,
      });

      clock = 61_000;
      expect(await core.reconcileExpiredResumableUploadLeases()).toEqual({
        completedUploads: 1,
        releasedUploads: 0,
      });
      expect(await core.getResumableUpload(tenant, upload.id)).toMatchObject({ complete: true });
      expect(await core.getObjectMetadata(tenant, "assets", "leases/recovered.bin")).toMatchObject({
        size: 3,
        version: "version-lease-001",
      });
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("releases reservations after an expired resumable lease has a fatal provider result", async () => {
    const directory = await temporaryDirectory("mekka-storage-lease-release-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    const failingProvider = new FailOncePutProvider(provider);
    let clock = 1_000;
    let uploadNumber = 0;
    const core = createObjectStorageCore({
      metadata,
      provider: failingProvider,
      policy: allowAllPolicy,
      now: () => clock,
      createVersion: () => "version-lease-release-001",
      createUploadId: () => `upload-lease-release-00${++uploadNumber}`,
      maxUploadSessionsPerTenant: 1,
      maxUploadBytesPerTenant: 3,
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      const upload = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "leases/released.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-lease-release-001",
        expiresAt: 120_000,
      });
      await expect(
        core.appendResumableUpload(tenant, upload.id, 0, bytes("one")),
      ).rejects.toMatchObject({
        code: "STORAGE_CORE_INFRASTRUCTURE",
        retryable: true,
      });

      clock = 61_000;
      const recoveryCore = createObjectStorageCore({
        metadata,
        provider: new FatalHeadProvider(provider),
        policy: allowAllPolicy,
        now: () => clock,
        createUploadId: () => `upload-lease-release-00${++uploadNumber}`,
        maxUploadSessionsPerTenant: 1,
        maxUploadBytesPerTenant: 3,
      });
      expect(await recoveryCore.reconcileExpiredResumableUploadLeases()).toEqual({
        completedUploads: 0,
        releasedUploads: 1,
      });
      expect(
        metadata.execute<{ state: string }>({
          sql: "SELECT state FROM storage_uploads WHERE upload_id = ?",
          parameters: [upload.id],
        }).rows,
      ).toEqual([{ state: "pending_delete" }]);
      expect(
        metadata.execute<{ count: number }>({
          sql: "SELECT COUNT(*) AS count FROM storage_objects WHERE object_path = 'leases/released.bin'",
        }).rows,
      ).toEqual([{ count: 0 }]);
      await expect(
        recoveryCore.createResumableUpload(tenant, {
          bucketName: "assets",
          path: "leases/released.bin",
          uploadLength: 3,
          contentType: "application/octet-stream",
          idempotencyKey: "upload-lease-release-001",
          expiresAt: 120_000,
        }),
      ).resolves.toMatchObject({ id: "upload-lease-release-002" });
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("enforces resumable session, byte, chunk quotas and supports abort", async () => {
    const directory = await temporaryDirectory("mekka-storage-upload-quota-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    let uploadNumber = 0;
    const core = createObjectStorageCore({
      metadata,
      provider,
      policy: allowAllPolicy,
      now: () => 1_000,
      createUploadId: () => {
        uploadNumber += 1;
        return `upload-quota-00${uploadNumber}`;
      },
      maxObjectBytes: 6,
      maxUploadSessionsPerTenant: 1,
      maxUploadBytesPerTenant: 5,
      maxUploadChunkBytes: 2,
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      const upload = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "quota/one.txt",
        uploadLength: 5,
        contentType: "text/plain",
        idempotencyKey: "upload-quota-one-001",
        expiresAt: 2_000,
      });
      await expect(
        core.createResumableUpload(tenant, {
          bucketName: "assets",
          path: "quota/two.txt",
          uploadLength: 1,
          contentType: "text/plain",
          idempotencyKey: "upload-quota-two-001",
          expiresAt: 2_000,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_QUOTA" });
      await expect(
        core.appendResumableUpload(tenant, upload.id, 0, bytes("abc")),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_QUOTA" });
      await core.abortResumableUpload(tenant, upload.id);
      await expect(core.getResumableUpload(tenant, upload.id)).rejects.toMatchObject({
        code: "STORAGE_CORE_NOT_FOUND",
      });
      await expect(
        core.createResumableUpload(tenant, {
          bucketName: "assets",
          path: "quota/large.txt",
          uploadLength: 7,
          contentType: "text/plain",
          idempotencyKey: "upload-quota-large-001",
          expiresAt: 2_000,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_QUOTA" });
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("counts completed resumable sessions against quota until abort or expiry", async () => {
    const directory = await temporaryDirectory("mekka-storage-completed-quota-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    let clock = 1_000;
    let uploadNumber = 0;
    const core = createObjectStorageCore({
      metadata,
      provider,
      policy: allowAllPolicy,
      now: () => clock,
      createUploadId: () => `upload-completed-00${++uploadNumber}`,
      maxUploadSessionsPerTenant: 1,
      maxUploadBytesPerTenant: 3,
    });
    const tenant = context("project-one", 1);
    try {
      await core.createBucket(tenant, { name: "assets" });
      const first = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "quota/first.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-completed-first-001",
        expiresAt: 2_000,
      });
      await core.appendResumableUpload(tenant, first.id, 0, bytes("one"));
      await expect(
        core.createResumableUpload(tenant, {
          bucketName: "assets",
          path: "quota/second.bin",
          uploadLength: 1,
          contentType: "application/octet-stream",
          idempotencyKey: "upload-completed-second-001",
          expiresAt: 2_000,
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_QUOTA" });

      await core.abortResumableUpload(tenant, first.id);
      const second = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "quota/second.bin",
        uploadLength: 1,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-completed-second-001",
        expiresAt: 2_000,
      });
      expect(await core.getObjectMetadata(tenant, "assets", "quota/first.bin")).toMatchObject({
        size: 3,
      });
      clock = 2_000;
      expect(core.cleanupExpiredResumableUploads()).toBe(1);
      await expect(core.getResumableUpload(tenant, second.id)).rejects.toMatchObject({
        code: "STORAGE_CORE_NOT_FOUND",
      });
    } finally {
      provider.close();
      metadata.close();
    }
  });

  test("prevents abort races before and during resumable finalization", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    const delayedProvider = new DelayedPutProvider(fixture.provider);
    let clock = 1_000;
    let uploadNumber = 0;
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: delayedProvider,
      policy: allowAllPolicy,
      now: () => clock,
      createUploadId: () => `upload-race-00${++uploadNumber}`,
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      const finalizing = await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "race/finalizing.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-race-finalizing-001",
        expiresAt: 2_000,
      });
      const append = core.appendResumableUpload(tenant, finalizing.id, 0, bytes("one"));
      await delayedProvider.entered;
      clock = 2_000;
      expect(core.cleanupExpiredResumableUploads()).toBe(0);
      const concurrentCore = createObjectStorageCore({
        metadata: fixture.metadata,
        provider: fixture.provider,
        policy: allowAllPolicy,
        now: () => clock,
      });
      await concurrentCore.putObject(tenant, {
        bucketName: "assets",
        path: "race/concurrent.bin",
        body: bytes("safe"),
        contentType: "application/octet-stream",
        idempotencyKey: "put-race-concurrent-001",
      });
      await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "race/next.bin",
        uploadLength: 1,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-race-next-001",
        expiresAt: 3_000,
      });
      await expect(core.abortResumableUpload(tenant, finalizing.id)).rejects.toMatchObject({
        code: "STORAGE_CORE_CONFLICT",
      });
      delayedProvider.release();
      await expect(append).resolves.toMatchObject({ upload: { complete: true } });
      expect(core.cleanupExpiredResumableUploads()).toBe(1);

      const gate = new GateFirstAuthorizationPolicy();
      const abortFirstCore = createObjectStorageCore({
        metadata: fixture.metadata,
        provider: fixture.provider,
        policy: gate,
        now: () => clock,
        createUploadId: () => "upload-race-abort-first-001",
      });
      const abortFirst = await abortFirstCore.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "race/abort-first.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-race-abort-first-001",
        expiresAt: 3_000,
      });
      gate.activate();
      const losingAppend = abortFirstCore.appendResumableUpload(
        tenant,
        abortFirst.id,
        0,
        bytes("two"),
      );
      await gate.entered;
      await abortFirstCore.abortResumableUpload(tenant, abortFirst.id);
      gate.release();
      await expect(losingAppend).rejects.toMatchObject({ code: "STORAGE_CORE_NOT_FOUND" });
      await expect(
        abortFirstCore.getObjectMetadata(tenant, "assets", "race/abort-first.bin"),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_NOT_FOUND" });
    } finally {
      delayedProvider.release();
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("standard puts conflict with non-expired resumable reservations", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    let clock = 1_000;
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: fixture.provider,
      policy: allowAllPolicy,
      now: () => clock,
      createUploadId: () => "upload-reservation-001",
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      await core.createResumableUpload(tenant, {
        bucketName: "assets",
        path: "reserved/path.bin",
        uploadLength: 3,
        contentType: "application/octet-stream",
        idempotencyKey: "upload-reservation-key-001",
        expiresAt: 2_000,
      });
      await expect(
        core.putObject(tenant, {
          bucketName: "assets",
          path: "reserved/path.bin",
          body: bytes("one"),
          contentType: "application/octet-stream",
          idempotencyKey: "ordinary-reserved-path-001",
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_CONFLICT" });
      await expect(
        core.putObject(tenant, {
          bucketName: "assets",
          path: "reserved/key.bin",
          body: bytes("two"),
          contentType: "application/octet-stream",
          idempotencyKey: "upload-reservation-key-001",
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_CONFLICT" });

      clock = 2_000;
      await expect(
        core.putObject(tenant, {
          bucketName: "assets",
          path: "reserved/path.bin",
          body: bytes("one"),
          contentType: "application/octet-stream",
          idempotencyKey: "ordinary-reserved-path-001",
        }),
      ).resolves.toMatchObject({ path: "reserved/path.bin" });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("rejects deletion while object creation is in flight", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    const delayedProvider = new DelayedPutProvider(fixture.provider);
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: delayedProvider,
      policy: allowAllPolicy,
      createVersion: () => "version001",
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      const creating = core.putObject(tenant, {
        bucketName: "assets",
        path: "in-flight.txt",
        body: bytes("in flight"),
        contentType: "text/plain",
        idempotencyKey: "put-in-flight-001",
      });
      await delayedProvider.entered;
      await expect(core.deleteObject(tenant, "assets", "in-flight.txt")).rejects.toMatchObject({
        code: "STORAGE_CORE_CONFLICT",
      });
      delayedProvider.release();
      await expect(creating).resolves.toMatchObject({ path: "in-flight.txt" });
      expect(await core.reconcileBucket(tenant, "assets")).toMatchObject({ issues: [] });
    } finally {
      delayedProvider.release();
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("does not report objects committed during provider listing as orphans", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    let core: ReturnType<typeof createObjectStorageCore>;
    const provider = new ListHookProvider(fixture.provider, async () => {
      await core.putObject(tenant, {
        bucketName: "assets",
        path: "during-reconcile.txt",
        body: bytes("concurrent"),
        contentType: "text/plain",
        idempotencyKey: "put-during-reconcile-001",
      });
    });
    core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider,
      policy: allowAllPolicy,
      createVersion: () => "version002",
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      expect(await core.reconcileBucket(tenant, "assets")).toMatchObject({ issues: [] });
      expect(await core.getObjectMetadata(tenant, "assets", "during-reconcile.txt")).toMatchObject({
        path: "during-reconcile.txt",
      });
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("maps metadata busy failures to a retryable storage-core error", async () => {
    const directory = await temporaryDirectory("mekka-storage-errors-");
    const metadata = openStorageAdapter({ databasePath: ":memory:" });
    const provider = createLocalObjectProvider(join(directory, "objects"));
    let fail = false;
    const failingMetadata: StorageAdapter = {
      execute(statement) {
        if (fail) {
          throw new StorageAdapterError(
            "STORAGE_BUSY",
            "SQLite database remained busy after the configured timeout.",
          );
        }
        return metadata.execute(statement);
      },
      transaction(callback) {
        return metadata.transaction(callback);
      },
      createCheckpoint(options) {
        metadata.createCheckpoint(options);
      },
      close() {
        metadata.close();
      },
    };
    const core = createObjectStorageCore({
      metadata: failingMetadata,
      provider,
      policy: allowAllPolicy,
    });
    try {
      fail = true;
      await expect(core.listBuckets(context("project-one", 1))).rejects.toMatchObject({
        code: "STORAGE_CORE_INFRASTRUCTURE",
        retryable: true,
      });
    } finally {
      provider.close();
      failingMetadata.close();
    }
  });

  test("enforces bucket/object quotas and treats wildcard paths as bound data", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    const core = createObjectStorageCore({
      metadata: fixture.metadata,
      provider: fixture.provider,
      policy: allowAllPolicy,
      maxBucketsPerTenant: 1,
      maxObjectBytes: 8,
      createVersion: () => "version003",
    });
    try {
      await core.createBucket(tenant, { name: "assets" });
      await expect(core.createBucket(tenant, { name: "second" })).rejects.toMatchObject({
        code: "STORAGE_CORE_QUOTA",
      });
      await expect(
        core.putObject(tenant, {
          bucketName: "assets",
          path: "too-large.txt",
          body: bytes("123456789"),
          contentType: "text/plain",
          idempotencyKey: "put-too-large-001",
        }),
      ).rejects.toMatchObject({ code: "STORAGE_CORE_QUOTA" });

      await core.putObject(tenant, {
        bucketName: "assets",
        path: "safe/%_'.txt",
        body: bytes("literal"),
        contentType: "text/plain",
        idempotencyKey: "put-literal-path-001",
      });
      await core.putObject(tenant, {
        bucketName: "assets",
        path: "safe/xx.txt",
        body: bytes("other"),
        contentType: "text/plain",
        idempotencyKey: "put-other-path-001",
      });
      expect(await core.listObjects(tenant, "assets", { prefix: "safe/%_" })).toMatchObject([
        { path: "safe/%_'.txt" },
      ]);
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });

  test("migrates v2 metadata once, preserves existing data, and rejects future schema versions", async () => {
    const fixture = await createFixture();
    const tenant = context("project-one", 1);
    try {
      await fixture.core.createBucket(tenant, { name: "assets" });
      await fixture.core.putObject(tenant, {
        bucketName: "assets",
        path: "existing.txt",
        body: bytes("existing"),
        contentType: "text/plain",
        idempotencyKey: "put-existing-data-001",
      });
      fixture.metadata.execute({ sql: "DROP TABLE storage_uploads" });
      fixture.metadata.execute({
        sql: `CREATE TABLE storage_uploads (
          organization_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          environment_id TEXT NOT NULL,
          branch_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          upload_id TEXT NOT NULL,
          actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service', 'agent')),
          actor_id TEXT NOT NULL,
          bucket_name TEXT NOT NULL,
          object_path TEXT NOT NULL,
          upload_length INTEGER NOT NULL CHECK (upload_length >= 0),
          upload_offset INTEGER NOT NULL CHECK (upload_offset >= 0 AND upload_offset <= upload_length),
          content_type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('uploading', 'finalizing', 'complete')),
          body BLOB NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (
            organization_id, project_id, environment_id, branch_id, generation, upload_id
          ),
          UNIQUE (
            organization_id, project_id, environment_id, branch_id, generation, idempotency_key
          ),
          UNIQUE (
            organization_id, project_id, environment_id, branch_id, generation,
            bucket_name, object_path
          )
        ) STRICT`,
      });
      fixture.metadata.execute({
        sql: "UPDATE storage_metadata_schema SET version = 2 WHERE singleton = 1",
      });
      const reopened = createObjectStorageCore({
        metadata: fixture.metadata,
        provider: fixture.provider,
        policy: allowAllPolicy,
        createVersion: () => "version004",
      });
      expect(await reopened.getObjectMetadata(tenant, "assets", "existing.txt")).toMatchObject({
        path: "existing.txt",
      });
      expect(
        fixture.metadata.execute<{ version: number }>({
          sql: "SELECT version FROM storage_metadata_schema WHERE singleton = 1",
        }).rows,
      ).toEqual([{ version: storageMetadataSchemaVersion }]);
      fixture.metadata.execute({
        sql: "UPDATE storage_metadata_schema SET version = ? WHERE singleton = 1",
        parameters: [storageMetadataSchemaVersion + 1],
      });
      expect(() =>
        createObjectStorageCore({
          metadata: fixture.metadata,
          provider: fixture.provider,
          policy: allowAllPolicy,
        }),
      ).toThrow(
        new StorageCoreError(
          "STORAGE_CORE_UNSUPPORTED",
          "Storage metadata schema version 4 is not supported.",
        ),
      );
    } finally {
      fixture.provider.close();
      fixture.metadata.close();
    }
  });
});

async function runProviderContract(provider: ObjectProvider): Promise<void> {
  const request = requestFor("tenant/bucket/file.txt", "hello", "provider-contract-001");
  const first = await provider.put(request);
  const second = await provider.put(request);
  expect(second).toEqual(first);
  expect(await provider.head(request.key)).toEqual(first);
  const read = await provider.get(request.key, 5);
  expect(read?.metadata).toEqual(first);
  expect(new TextDecoder().decode(read?.body)).toBe("hello");
  read?.body.fill(0);
  expect(new TextDecoder().decode((await provider.get(request.key, 5))?.body)).toBe("hello");
  await expect(provider.get(request.key, 4)).rejects.toMatchObject({
    code: "OBJECT_PROVIDER_INVALID",
  });
  expect(await provider.list("tenant/bucket/")).toEqual([first]);
  await expect(
    provider.put(requestFor(request.key, "different", "provider-contract-002")),
  ).rejects.toMatchObject({ code: "OBJECT_PROVIDER_CONFLICT", retryable: false });
  await provider.delete(request.key);
  await provider.delete(request.key);
  expect(await provider.head(request.key)).toBeNull();

  const mutableBody = bytes("immutable boundary");
  const mutableRequest = requestForBody(
    "tenant/bucket/mutable.txt",
    mutableBody,
    "provider-mutable-001",
  );
  const putting = provider.put(mutableRequest);
  mutableBody.fill(0);
  const stored = await putting;
  expect(stored.checksumSha256).toBe(mutableRequest.checksumSha256);
  expect(await provider.head(mutableRequest.key)).toMatchObject({
    checksumSha256: mutableRequest.checksumSha256,
  });
}

async function createFixture(usePolicy = true): Promise<{
  metadata: StorageAdapter;
  provider: ObjectProvider;
  core: ReturnType<typeof createObjectStorageCore>;
}> {
  const directory = await temporaryDirectory("mekka-storage-core-");
  const metadata = openStorageAdapter({ databasePath: ":memory:" });
  const provider = createLocalObjectProvider(join(directory, "objects"));
  const coreOptions = {
    metadata,
    provider,
    createVersion: () => "version001",
  };
  return {
    metadata,
    provider,
    core: createObjectStorageCore(
      usePolicy ? { ...coreOptions, policy: allowAllPolicy } : coreOptions,
    ),
  };
}

function context(projectId: string, generation: number): TenantContext {
  return contextWithActor(projectId, generation, "user-main");
}

function contextWithActor(projectId: string, generation: number, actorId: string): TenantContext {
  return createTenantContext({
    tenant: parseTenantIdentity({
      organizationId: "org-main",
      projectId,
      environmentId: "env-main",
      branchId: "branch-main",
      generation,
    }),
    actor: { kind: "user", id: actorId },
    capabilities: [],
    correlationId: parseCorrelationId("00000000-0000-4000-8000-000000000001"),
  });
}

function providerBucketPrefix(context: TenantContext, bucketName: string): string {
  const tenant = context.tenant;
  return [
    "tenants",
    tenant.organizationId,
    "projects",
    tenant.projectId,
    "environments",
    tenant.environmentId,
    "branches",
    tenant.branchId,
    "generations",
    tenant.generation,
    "buckets",
    bucketName,
    "objects",
    "",
  ].join("/");
}

function requestFor(
  key: string,
  content: string,
  idempotencyKey: string,
): ObjectProviderPutRequest {
  return requestForBody(key, bytes(content), idempotencyKey);
}

function requestForBody(
  key: string,
  body: Uint8Array,
  idempotencyKey: string,
): ObjectProviderPutRequest {
  return Object.freeze({
    key,
    body,
    contentType: "text/plain",
    checksumSha256: createHash("sha256").update(body).digest("hex"),
    idempotencyKey,
  });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function rewriteGrant(
  token: string,
  secret: Uint8Array,
  changes: Readonly<Record<string, string | number>>,
): string {
  const payload = token.split(".")[0];
  if (payload === undefined) {
    throw new Error("invalid test grant");
  }
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("invalid test grant");
  }
  const rewritten = Buffer.from(JSON.stringify({ ...decoded, ...changes }), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(rewritten).digest("base64url");
  return `${rewritten}.${signature}`;
}

function withTrailingBitAlias(token: string): string {
  const [payload, signature] = token.split(".");
  if (payload === undefined || signature === undefined) {
    throw new Error("invalid test grant");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = signature.at(-1);
  const index = last === undefined ? -1 : alphabet.indexOf(last);
  if (index < 0) {
    throw new Error("invalid test grant");
  }
  const alias = alphabet[(index & 0b111100) | ((index + 1) & 0b11)];
  return `${payload}.${signature.slice(0, -1)}${alias}`;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

class AmbiguousPutProvider implements ObjectProvider {
  private fail = true;

  constructor(private readonly delegate: ObjectProvider) {}

  async put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    const result = await this.delegate.put(request);
    if (this.fail) {
      this.fail = false;
      throw new ObjectProviderError(
        "OBJECT_PROVIDER_UNAVAILABLE",
        "Provider response was lost.",
        true,
      );
    }
    return result;
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {
    this.delegate.close();
  }
}

class FailOncePutProvider implements ObjectProvider {
  private fail = true;

  constructor(private readonly delegate: ObjectProvider) {}

  async put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    const result = await this.delegate.put(request);
    if (this.fail) {
      this.fail = false;
      throw new ObjectProviderError(
        "OBJECT_PROVIDER_UNAVAILABLE",
        "Provider response was lost.",
        true,
      );
    }
    return result;
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {}
}

class FatalHeadProvider implements ObjectProvider {
  constructor(private readonly delegate: ObjectProvider) {}

  put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    return this.delegate.put(request);
  }

  head(): Promise<ObjectProviderMetadata | null> {
    return Promise.reject(
      new ObjectProviderError(
        "OBJECT_PROVIDER_INVALID",
        "Provider object cannot be inspected.",
        false,
      ),
    );
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {}
}

class CorruptReadProvider implements ObjectProvider {
  constructor(private readonly delegate: ObjectProvider) {}

  put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    return this.delegate.put(request);
  }

  async get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    const result = await this.delegate.get(key, maxBytes);
    if (result === null) {
      return null;
    }
    const body = Uint8Array.from(result.body);
    body[0] = (body[0] ?? 0) ^ 1;
    return Object.freeze({ metadata: result.metadata, body });
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {}
}

class FailOnceDeleteProvider implements ObjectProvider {
  private fail = true;

  constructor(private readonly delegate: ObjectProvider) {}

  put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    return this.delegate.put(request);
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  async delete(key: string): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new ObjectProviderError(
        "OBJECT_PROVIDER_UNAVAILABLE",
        "Delete failed temporarily.",
        true,
      );
    }
    await this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {
    this.delegate.close();
  }
}

class DelayedPutProvider implements ObjectProvider {
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

  async put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    this.resolveEntered?.();
    await this.released;
    return this.delegate.put(request);
  }

  release(): void {
    this.resolveRelease?.();
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    return this.delegate.list(prefix);
  }

  close(): void {
    this.delegate.close();
  }
}

class GateFirstAuthorizationPolicy implements StoragePolicyHook {
  readonly entered: Promise<void>;
  private active = false;
  private blocked = false;
  private resolveEntered: (() => void) | undefined;
  private resolveRelease: (() => void) | undefined;
  private readonly released: Promise<void>;

  constructor() {
    this.entered = new Promise((resolve) => {
      this.resolveEntered = resolve;
    });
    this.released = new Promise((resolve) => {
      this.resolveRelease = resolve;
    });
  }

  activate(): void {
    this.active = true;
  }

  release(): void {
    this.resolveRelease?.();
  }

  async authorize(): Promise<boolean> {
    if (this.active && !this.blocked) {
      this.blocked = true;
      this.resolveEntered?.();
      await this.released;
    }
    return true;
  }
}

class ListHookProvider implements ObjectProvider {
  private invoked = false;

  constructor(
    private readonly delegate: ObjectProvider,
    private readonly hook: () => Promise<void>,
  ) {}

  put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata> {
    return this.delegate.put(request);
  }

  head(key: string): Promise<ObjectProviderMetadata | null> {
    return this.delegate.head(key);
  }

  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null> {
    return this.delegate.get(key, maxBytes);
  }

  delete(key: string): Promise<void> {
    return this.delegate.delete(key);
  }

  async list(prefix: string): Promise<readonly ObjectProviderMetadata[]> {
    if (!this.invoked) {
      this.invoked = true;
      await this.hook();
    }
    return this.delegate.list(prefix);
  }

  close(): void {
    this.delegate.close();
  }
}

class CountingProvider implements ObjectProvider {
  calls = 0;

  put(): Promise<ObjectProviderMetadata> {
    this.calls += 1;
    throw new Error("unexpected provider call");
  }

  head(): Promise<ObjectProviderMetadata | null> {
    this.calls += 1;
    throw new Error("unexpected provider call");
  }

  get(): Promise<ObjectProviderGetResult | null> {
    this.calls += 1;
    throw new Error("unexpected provider call");
  }

  delete(): Promise<void> {
    this.calls += 1;
    throw new Error("unexpected provider call");
  }

  list(): Promise<readonly ObjectProviderMetadata[]> {
    this.calls += 1;
    throw new Error("unexpected provider call");
  }

  close(): void {}
}

class FakeS3Client {
  sendCalls = 0;
  private readonly objects = new Map<
    string,
    Readonly<{ body: Uint8Array; checksum: string; idempotencyKey: string; etag: string }>
  >();

  corrupt(key: string, body: Uint8Array): void {
    const object = this.objects.get(key);
    if (object === undefined) {
      throw new Error("missing test object");
    }
    this.objects.set(key, { ...object, body: Uint8Array.from(body) });
  }

  async send(command: unknown): Promise<unknown> {
    this.sendCalls += 1;
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key ?? "");
      if (object === undefined) {
        throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      }
      return {
        Body: Uint8Array.from(object.body),
        ContentLength: object.body.byteLength,
        ETag: object.etag,
        Metadata: { "mekka-sha256": object.checksum },
      };
    }
    if (command instanceof HeadObjectCommand) {
      const key = command.input.Key ?? "";
      const object = this.objects.get(key);
      if (object === undefined) {
        throw Object.assign(new Error("missing"), { name: "NotFound" });
      }
      return {
        ContentLength: object.body.byteLength,
        ETag: object.etag,
        Metadata: {
          "mekka-sha256": object.checksum,
          "mekka-idempotency-key": object.idempotencyKey,
        },
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      if (command.input.IfNoneMatch === "*" && this.objects.has(key)) {
        throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
      }
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) {
        throw new Error("unexpected body");
      }
      const checksum = command.input.Metadata?.["mekka-sha256"] ?? "";
      const idempotencyKey = command.input.Metadata?.["mekka-idempotency-key"] ?? "";
      const etag = `"${checksum}"`;
      this.objects.set(key, { body, checksum, idempotencyKey, etag });
      return { ETag: etag };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return {
        Contents: [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((Key) => ({ Key })),
        IsTruncated: false,
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(command.input.Key ?? "");
      return {};
    }
    throw new Error("Unexpected S3 command");
  }
}
