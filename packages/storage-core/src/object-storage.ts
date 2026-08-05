import { createHash, randomUUID } from "node:crypto";
import type { TenantContext, TenantIdentity } from "@mekka/protocol";
import type { StorageAdapter, StorageExecutor, StorageValue } from "./index";
import {
  type ObjectProvider,
  ObjectProviderError,
  type ObjectProviderGetResult,
  type ObjectProviderMetadata,
} from "./object-provider";
import {
  createSignedReadGrantAuthority,
  type SignedReadGrantAuthority,
  type SignedReadGrantAuthorityOptions,
  type VerifiedReadGrant,
} from "./signed-read-grant";

export type StorageSignedReadGrantOptions = SignedReadGrantAuthorityOptions;
export type StorageVerifiedReadGrant = VerifiedReadGrant;

export type StoragePolicyAction =
  | "bucket:create"
  | "bucket:read"
  | "bucket:update"
  | "bucket:delete"
  | "object:create"
  | "object:list"
  | "object:read"
  | "object:delete"
  | "object:reconcile";

export type StoragePolicyRequest = Readonly<{
  context: TenantContext;
  action: StoragePolicyAction;
  bucketName?: string;
  objectPath?: string;
}>;

export interface StoragePolicyHook {
  authorize(request: StoragePolicyRequest): boolean | Promise<boolean>;
}

export const denyAllStoragePolicy: StoragePolicyHook = Object.freeze({ authorize: () => false });

export type StorageCoreErrorCode =
  | "STORAGE_CORE_VALIDATION"
  | "STORAGE_CORE_FORBIDDEN"
  | "STORAGE_CORE_NOT_FOUND"
  | "STORAGE_CORE_CONFLICT"
  | "STORAGE_CORE_QUOTA"
  | "STORAGE_CORE_UNSUPPORTED"
  | "STORAGE_CORE_INFRASTRUCTURE";

export class StorageCoreError extends Error {
  readonly code: StorageCoreErrorCode;
  readonly retryable: boolean;

  constructor(code: StorageCoreErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "StorageCoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type StorageBucket = Readonly<{
  name: string;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type StorageObjectMetadata = Readonly<{
  bucketName: string;
  path: string;
  size: number;
  contentType: string;
  checksumSha256: string;
  providerEtag: string | null;
  version: string;
  createdAt: number;
  updatedAt: number;
}>;

export type StorageObject = Readonly<{
  metadata: StorageObjectMetadata;
  body: Uint8Array;
}>;

export type StoragePolicySummary = Readonly<{
  bucketName: string;
  canUpdateBucket: boolean;
  canDeleteBucket: boolean;
  canListObjects: boolean;
  canCreateObjects: boolean;
  canReadObjects: boolean;
  canDeleteObjects: boolean;
}>;

export type ResumableUpload = Readonly<{
  id: string;
  bucketName: string;
  path: string;
  uploadLength: number;
  offset: number;
  contentType: string;
  idempotencyKey: string;
  expiresAt: number;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type ResumableUploadAppendResult = Readonly<{
  upload: ResumableUpload;
  object: StorageObjectMetadata | null;
}>;

export type ReconciliationIssue = Readonly<{
  kind:
    | "retry_put"
    | "provider_missing"
    | "provider_mismatch"
    | "orphan_provider_object"
    | "retry_delete";
  bucketName: string;
  objectPath: string | null;
  providerKey: string;
  retryable: boolean;
}>;

export type ReconciliationReport = Readonly<{
  completedPuts: number;
  completedDeletes: number;
  issues: readonly ReconciliationIssue[];
}>;

export type ObjectStorageCoreOptions = Readonly<{
  metadata: StorageAdapter;
  provider: ObjectProvider;
  policy?: StoragePolicyHook;
  maxBucketsPerTenant?: number;
  maxObjectBytes?: number;
  maxListResults?: number;
  maxUploadSessionsPerTenant?: number;
  maxUploadBytesPerTenant?: number;
  maxUploadChunkBytes?: number;
  signedReadGrants?: StorageSignedReadGrantOptions;
  now?: () => number;
  createVersion?: () => string;
  createUploadId?: () => string;
}>;

export interface ObjectStorageCore {
  createBucket(
    context: TenantContext,
    input: Readonly<{ name: string; isPublic?: boolean }>,
  ): Promise<StorageBucket>;
  getBucket(context: TenantContext, bucketName: string): Promise<StorageBucket>;
  listBuckets(context: TenantContext): Promise<readonly StorageBucket[]>;
  updateBucket(
    context: TenantContext,
    bucketName: string,
    input: Readonly<{ isPublic: boolean }>,
  ): Promise<StorageBucket>;
  deleteBucket(context: TenantContext, bucketName: string): Promise<void>;
  putObject(
    context: TenantContext,
    input: Readonly<{
      bucketName: string;
      path: string;
      body: Uint8Array;
      contentType: string;
      idempotencyKey: string;
    }>,
  ): Promise<StorageObjectMetadata>;
  getObject(context: TenantContext, bucketName: string, path: string): Promise<StorageObject>;
  getObjectMetadata(
    context: TenantContext,
    bucketName: string,
    path: string,
  ): Promise<StorageObjectMetadata>;
  listObjects(
    context: TenantContext,
    bucketName: string,
    options?: Readonly<{ prefix?: string; limit?: number }>,
  ): Promise<readonly StorageObjectMetadata[]>;
  getPolicySummary(context: TenantContext, bucketName: string): Promise<StoragePolicySummary>;
  deleteObject(context: TenantContext, bucketName: string, path: string): Promise<void>;
  issueReadGrant(
    context: TenantContext,
    bucketName: string,
    path: string,
    expiresAt: number,
  ): Promise<string>;
  verifyReadGrant(token: string): StorageVerifiedReadGrant;
  redeemReadGrant(
    grant: StorageVerifiedReadGrant,
    target: Readonly<{
      tenant: TenantIdentity;
      bucketName: string;
      path: string;
      action: "object:read";
    }>,
  ): Promise<StorageObject>;
  redeemReadGrantMetadata(
    grant: StorageVerifiedReadGrant,
    target: Readonly<{
      tenant: TenantIdentity;
      bucketName: string;
      path: string;
      action: "object:read";
    }>,
  ): Promise<StorageObjectMetadata>;
  createResumableUpload(
    context: TenantContext,
    input: Readonly<{
      bucketName: string;
      path: string;
      uploadLength: number;
      contentType: string;
      idempotencyKey: string;
      expiresAt: number;
    }>,
  ): Promise<ResumableUpload>;
  getResumableUpload(context: TenantContext, uploadId: string): Promise<ResumableUpload>;
  appendResumableUpload(
    context: TenantContext,
    uploadId: string,
    offset: number,
    chunk: Uint8Array,
  ): Promise<ResumableUploadAppendResult>;
  abortResumableUpload(context: TenantContext, uploadId: string): Promise<void>;
  cleanupExpiredResumableUploads(): number;
  reconcileBucket(context: TenantContext, bucketName: string): Promise<ReconciliationReport>;
}

type BucketRow = Readonly<{
  name: string;
  is_public: number;
  created_at: number;
  updated_at: number;
}>;

type ObjectState = "pending_put" | "ready" | "pending_delete";

type ObjectRow = Readonly<{
  bucket_name: string;
  object_path: string;
  provider_key: string;
  state: ObjectState;
  size: number;
  content_type: string;
  checksum_sha256: string;
  provider_etag: string | null;
  version: string;
  idempotency_key: string;
  created_at: number;
  updated_at: number;
}>;

type UploadState = "uploading" | "finalizing" | "complete";

type UploadRow = Readonly<{
  upload_id: string;
  actor_kind: string;
  actor_id: string;
  bucket_name: string;
  object_path: string;
  upload_length: number;
  upload_offset: number;
  content_type: string;
  idempotency_key: string;
  expires_at: number;
  state: UploadState;
  body: Uint8Array;
  created_at: number;
  updated_at: number;
}>;

type RuntimeOptions = Readonly<{
  metadata: StorageAdapter;
  provider: ObjectProvider;
  policy: StoragePolicyHook;
  maxBuckets: number;
  maxObjectBytes: number;
  maxListResults: number;
  maxUploadSessions: number;
  maxUploadBytes: number;
  maxUploadChunkBytes: number;
  signedReadGrants: SignedReadGrantAuthority | null;
  now: () => number;
  createVersion: () => string;
  createUploadId: () => string;
}>;

const bucketNamePattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const storageObjectPathMaxUtf8Bytes = 384;
export const storageObjectPathSegmentMaxUtf8Bytes = 180;
export const storageMetadataSchemaVersion = 2;

export function createObjectStorageCore(options: ObjectStorageCoreOptions): ObjectStorageCore {
  const runtime: RuntimeOptions = Object.freeze({
    metadata: options.metadata,
    provider: options.provider,
    policy: options.policy ?? denyAllStoragePolicy,
    maxBuckets: positiveLimit(options.maxBucketsPerTenant ?? 100, "maxBucketsPerTenant"),
    maxObjectBytes: positiveLimit(options.maxObjectBytes ?? 50 * 1024 * 1024, "maxObjectBytes"),
    maxListResults: positiveLimit(options.maxListResults ?? 100, "maxListResults"),
    maxUploadSessions: positiveLimit(
      options.maxUploadSessionsPerTenant ?? 20,
      "maxUploadSessionsPerTenant",
    ),
    maxUploadBytes: positiveLimit(
      options.maxUploadBytesPerTenant ?? 200 * 1024 * 1024,
      "maxUploadBytesPerTenant",
    ),
    maxUploadChunkBytes: positiveLimit(
      options.maxUploadChunkBytes ?? 5 * 1024 * 1024,
      "maxUploadChunkBytes",
    ),
    signedReadGrants:
      options.signedReadGrants === undefined
        ? null
        : createSignedReadGrantAuthority({
            ...options.signedReadGrants,
            now: options.signedReadGrants.now ?? options.now ?? Date.now,
          }),
    now: options.now ?? Date.now,
    createVersion: options.createVersion ?? randomUUID,
    createUploadId: options.createUploadId ?? randomUUID,
  });
  initializeMetadata(runtime.metadata);

  const core: ObjectStorageCore = {
    createBucket: (context, input) => runCoreOperation(() => createBucket(runtime, context, input)),
    getBucket: (context, bucketName) =>
      runCoreOperation(() => getBucket(runtime, context, bucketName)),
    listBuckets: (context) => runCoreOperation(() => listBuckets(runtime, context)),
    updateBucket: (context, bucketName, input) =>
      runCoreOperation(() => updateBucket(runtime, context, bucketName, input)),
    deleteBucket: (context, bucketName) =>
      runCoreOperation(() => deleteBucket(runtime, context, bucketName)),
    putObject: (context, input) => runCoreOperation(() => putObject(runtime, context, input)),
    getObject: (context, bucketName, path) =>
      runCoreOperation(() => getObject(runtime, context, bucketName, path)),
    getObjectMetadata: (context, bucketName, path) =>
      runCoreOperation(() => getObjectMetadata(runtime, context, bucketName, path)),
    listObjects: (context, bucketName, listOptions) =>
      runCoreOperation(() => listObjects(runtime, context, bucketName, listOptions)),
    getPolicySummary: (context, bucketName) =>
      runCoreOperation(() => getPolicySummary(runtime, context, bucketName)),
    deleteObject: (context, bucketName, path) =>
      runCoreOperation(() => deleteObject(runtime, context, bucketName, path)),
    issueReadGrant: (context, bucketName, path, expiresAt) =>
      runCoreOperation(() => issueReadGrant(runtime, context, bucketName, path, expiresAt)),
    verifyReadGrant: (token) => verifyReadGrant(runtime, token),
    redeemReadGrant: (grant, target) =>
      runCoreOperation(() => redeemReadGrant(runtime, grant, target)),
    redeemReadGrantMetadata: (grant, target) =>
      runCoreOperation(() => redeemReadGrantMetadata(runtime, grant, target)),
    createResumableUpload: (context, input) =>
      runCoreOperation(() => createResumableUpload(runtime, context, input)),
    getResumableUpload: (context, uploadId) =>
      runCoreOperation(() => getResumableUpload(runtime, context, uploadId)),
    appendResumableUpload: (context, uploadId, offset, chunk) =>
      runCoreOperation(() => appendResumableUpload(runtime, context, uploadId, offset, chunk)),
    abortResumableUpload: (context, uploadId) =>
      runCoreOperation(() => abortResumableUpload(runtime, context, uploadId)),
    cleanupExpiredResumableUploads: () => cleanupExpiredResumableUploads(runtime),
    reconcileBucket: (context, bucketName) =>
      runCoreOperation(() => reconcileBucket(runtime, context, bucketName)),
  };
  return Object.freeze(core);
}

async function createBucket(
  runtime: RuntimeOptions,
  context: TenantContext,
  input: Readonly<{ name: string; isPublic?: boolean }>,
): Promise<StorageBucket> {
  const name = normalizeBucketName(input.name);
  if (input.isPublic !== undefined && typeof input.isPublic !== "boolean") {
    throw validation("Bucket public setting must be a boolean.");
  }
  await authorize(runtime.policy, { context, action: "bucket:create", bucketName: name });
  const isPublic = input.isPublic ?? false;
  const tenant = tenantParameters(context.tenant);
  const timestamp = validTimestamp(runtime.now());

  return runtime.metadata.transaction((transaction) => {
    const existing = findBucket(transaction, tenant, name);
    if (existing !== null) {
      if (existing.is_public === Number(isPublic)) {
        return toBucket(existing);
      }
      throw conflict("Bucket already exists with different settings.");
    }
    const count = transaction.execute<{ count: number }>({
      sql: `SELECT COUNT(*) AS count FROM storage_buckets
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ?`,
      parameters: tenant,
    }).rows[0]?.count;
    if (typeof count !== "number") {
      throw infrastructure("Bucket count could not be read.");
    }
    if (count >= runtime.maxBuckets) {
      throw new StorageCoreError("STORAGE_CORE_QUOTA", "Bucket quota was exceeded.");
    }
    transaction.execute({
      sql: `INSERT INTO storage_buckets (
          organization_id, project_id, environment_id, branch_id, generation,
          name, is_public, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parameters: [...tenant, name, Number(isPublic), timestamp, timestamp],
    });
    return Object.freeze({ name, isPublic, createdAt: timestamp, updatedAt: timestamp });
  });
}

async function getBucket(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketName: string,
): Promise<StorageBucket> {
  const name = normalizeBucketName(bucketName);
  await authorize(runtime.policy, { context, action: "bucket:read", bucketName: name });
  const bucket = findBucket(runtime.metadata, tenantParameters(context.tenant), name);
  if (bucket === null) {
    throw notFound("Bucket was not found.");
  }
  return toBucket(bucket);
}

async function listBuckets(
  runtime: RuntimeOptions,
  context: TenantContext,
): Promise<readonly StorageBucket[]> {
  await authorize(runtime.policy, { context, action: "bucket:read" });
  const rows = runtime.metadata.execute<BucketRow>({
    sql: `SELECT name, is_public, created_at, updated_at FROM storage_buckets
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? ORDER BY name LIMIT ?`,
    parameters: [...tenantParameters(context.tenant), runtime.maxListResults],
  }).rows;
  return Object.freeze(rows.map(toBucket));
}

async function updateBucket(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketName: string,
  input: Readonly<{ isPublic: boolean }>,
): Promise<StorageBucket> {
  const name = normalizeBucketName(bucketName);
  if (typeof input.isPublic !== "boolean") {
    throw validation("Bucket public setting must be a boolean.");
  }
  await authorize(runtime.policy, { context, action: "bucket:update", bucketName: name });
  const tenant = tenantParameters(context.tenant);
  const result = runtime.metadata.execute({
    sql: `UPDATE storage_buckets SET is_public = ?, updated_at = ?
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND name = ?`,
    parameters: [Number(input.isPublic), validTimestamp(runtime.now()), ...tenant, name],
  });
  if (result.changes !== 1) {
    throw notFound("Bucket was not found.");
  }
  const bucket = findBucket(runtime.metadata, tenant, name);
  if (bucket === null) {
    throw infrastructure("Updated bucket could not be read.");
  }
  return toBucket(bucket);
}

async function deleteBucket(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketName: string,
): Promise<void> {
  const name = normalizeBucketName(bucketName);
  await authorize(runtime.policy, { context, action: "bucket:delete", bucketName: name });
  const tenant = tenantParameters(context.tenant);
  let providerObjects: readonly ObjectProviderMetadata[];
  try {
    providerObjects = await runtime.provider.list(createBucketProviderPrefix(context.tenant, name));
  } catch (error) {
    throw mapProviderError(error);
  }
  if (providerObjects.length > 0) {
    throw conflict("Bucket must not contain provider objects before deletion.");
  }
  runtime.metadata.transaction((transaction) => {
    if (findBucket(transaction, tenant, name) === null) {
      return;
    }
    const objectCount = transaction.execute<{ count: number }>({
      sql: `SELECT COUNT(*) AS count FROM storage_objects
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND bucket_name = ?`,
      parameters: [...tenant, name],
    }).rows[0]?.count;
    if (objectCount !== 0) {
      throw conflict("Bucket must be empty before deletion.");
    }
    transaction.execute({
      sql: `DELETE FROM storage_buckets
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND name = ?`,
      parameters: [...tenant, name],
    });
  });
}

async function putObject(
  runtime: RuntimeOptions,
  context: TenantContext,
  input: Readonly<{
    bucketName: string;
    path: string;
    body: Uint8Array;
    contentType: string;
    idempotencyKey: string;
    resumableUploadId?: string;
  }>,
): Promise<StorageObjectMetadata> {
  const bucketName = normalizeBucketName(input.bucketName);
  const objectPath = normalizeObjectPath(input.path);
  const contentType = normalizeContentType(input.contentType);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (!(input.body instanceof Uint8Array)) {
    throw validation("Object body must be a Uint8Array.");
  }
  if (input.body.byteLength > runtime.maxObjectBytes) {
    throw new StorageCoreError("STORAGE_CORE_QUOTA", "Object size limit was exceeded.");
  }
  const body = Uint8Array.from(input.body);
  await authorize(runtime.policy, {
    context,
    action: "object:create",
    bucketName,
    objectPath,
  });

  const tenant = tenantParameters(context.tenant);
  requireBucket(runtime.metadata, tenant, bucketName);
  const checksumSha256 = createHash("sha256").update(body).digest("hex");
  const timestamp = validTimestamp(runtime.now());
  let row = runtime.metadata.transaction((transaction) => {
    const existing = findObject(transaction, tenant, bucketName, objectPath);
    if (existing !== null) {
      if (
        existing.idempotency_key === idempotencyKey &&
        existing.checksum_sha256 === checksumSha256 &&
        existing.content_type === contentType
      ) {
        if (existing.state === "pending_delete") {
          throw conflict("Object deletion is pending.");
        }
        return existing;
      }
      throw conflict("Object already exists or the idempotency key was reused.");
    }
    if (findObjectByIdempotencyKey(transaction, tenant, idempotencyKey) !== null) {
      throw conflict("Idempotency key was already used for another object.");
    }
    transaction.execute({
      sql: `DELETE FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND expires_at <= ?
          AND state <> 'finalizing'`,
      parameters: [...tenant, timestamp],
    });
    const pathReservation = findUploadByPath(transaction, tenant, bucketName, objectPath);
    const keyReservation = findUploadByIdempotencyKey(transaction, tenant, idempotencyKey);
    if (
      isConflictingUploadReservation(pathReservation, input.resumableUploadId) ||
      isConflictingUploadReservation(keyReservation, input.resumableUploadId)
    ) {
      throw conflict("Object target or idempotency key is reserved by a resumable upload.");
    }

    const version = normalizeVersion(runtime.createVersion());
    const providerKey = createObjectProviderKey(context.tenant, bucketName, objectPath, version);
    transaction.execute({
      sql: `INSERT INTO storage_objects (
          organization_id, project_id, environment_id, branch_id, generation,
          bucket_name, object_path, provider_key, state, size, content_type,
          checksum_sha256, provider_etag, version, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_put', ?, ?, ?, NULL, ?, ?, ?, ?)`,
      parameters: [
        ...tenant,
        bucketName,
        objectPath,
        providerKey,
        body.byteLength,
        contentType,
        checksumSha256,
        version,
        idempotencyKey,
        timestamp,
        timestamp,
      ],
    });
    const inserted = findObject(transaction, tenant, bucketName, objectPath);
    if (inserted === null) {
      throw infrastructure("Pending object metadata could not be read.");
    }
    return inserted;
  });

  if (row.state === "ready") {
    return toObjectMetadata(row);
  }

  let providerMetadata: ObjectProviderMetadata;
  try {
    providerMetadata = await runtime.provider.put({
      key: row.provider_key,
      body,
      contentType,
      checksumSha256,
      idempotencyKey,
    });
  } catch (error) {
    throw mapProviderError(error);
  }
  verifyProviderMetadata(providerMetadata, row, body.byteLength);

  const update = runtime.metadata.execute({
    sql: `UPDATE storage_objects SET state = 'ready', provider_etag = ?, updated_at = ?
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?
        AND provider_key = ? AND state = 'pending_put'`,
    parameters: [
      providerMetadata.etag,
      validTimestamp(runtime.now()),
      ...tenant,
      bucketName,
      objectPath,
      row.provider_key,
    ],
  });
  if (update.changes !== 1) {
    const current = findObject(runtime.metadata, tenant, bucketName, objectPath);
    if (
      current === null ||
      current.state !== "ready" ||
      current.idempotency_key !== idempotencyKey ||
      current.checksum_sha256 !== checksumSha256
    ) {
      throw infrastructure("Object provider succeeded but metadata finalization is pending.");
    }
    return toObjectMetadata(current);
  }
  row = findObject(runtime.metadata, tenant, bucketName, objectPath) ?? row;
  if (row.state !== "ready") {
    throw infrastructure("Finalized object metadata could not be read.");
  }
  return toObjectMetadata(row);
}

async function getObject(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
  pathInput: string,
): Promise<StorageObject> {
  const bucketName = normalizeBucketName(bucketNameInput);
  const objectPath = normalizeObjectPath(pathInput);
  await authorize(runtime.policy, {
    context,
    action: "object:read",
    bucketName,
    objectPath,
  });
  const row = requireReadyObject(
    runtime.metadata,
    tenantParameters(context.tenant),
    bucketName,
    objectPath,
  );
  return readObject(runtime, row);
}

async function issueReadGrant(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
  pathInput: string,
  expiresAt: number,
): Promise<string> {
  const authority = requireSignedReadGrantAuthority(runtime);
  const bucketName = normalizeBucketName(bucketNameInput);
  const objectPath = normalizeObjectPath(pathInput);
  const now = validTimestamp(runtime.now());
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw validation("Signed grant expiry is invalid.");
  }
  await authorize(runtime.policy, {
    context,
    action: "object:read",
    bucketName,
    objectPath,
  });
  const row = requireReadyObject(
    runtime.metadata,
    tenantParameters(context.tenant),
    bucketName,
    objectPath,
  );
  try {
    return authority.issue({
      tenant: context.tenant,
      bucketName,
      objectPath,
      objectVersion: row.version,
      expiresAt,
    });
  } catch {
    throw validation("Signed grant is invalid.");
  }
}

function verifyReadGrant(runtime: RuntimeOptions, token: string): VerifiedReadGrant {
  try {
    return requireSignedReadGrantAuthority(runtime).verify(token);
  } catch {
    throw validation("Signed grant is invalid.");
  }
}

async function redeemReadGrant(
  runtime: RuntimeOptions,
  grant: VerifiedReadGrant,
  target: Readonly<{
    tenant: TenantIdentity;
    bucketName: string;
    path: string;
    action: "object:read";
  }>,
): Promise<StorageObject> {
  return readObject(runtime, requireRedeemableReadGrant(runtime, grant, target));
}

async function redeemReadGrantMetadata(
  runtime: RuntimeOptions,
  grant: VerifiedReadGrant,
  target: Readonly<{
    tenant: TenantIdentity;
    bucketName: string;
    path: string;
    action: "object:read";
  }>,
): Promise<StorageObjectMetadata> {
  return toObjectMetadata(requireRedeemableReadGrant(runtime, grant, target));
}

function requireRedeemableReadGrant(
  runtime: RuntimeOptions,
  grant: VerifiedReadGrant,
  target: Readonly<{
    tenant: TenantIdentity;
    bucketName: string;
    path: string;
    action: "object:read";
  }>,
): ObjectRow {
  const authority = requireSignedReadGrantAuthority(runtime);
  const bucketName = normalizeBucketName(target.bucketName);
  const objectPath = normalizeObjectPath(target.path);
  if (
    !authority.accepts(grant) ||
    grant.claims.action !== target.action ||
    grant.claims.action !== "object:read" ||
    grant.claims.bucketName !== bucketName ||
    grant.claims.objectPath !== objectPath ||
    !sameTenant(grant.claims.tenant, target.tenant) ||
    grant.claims.expiresAt <= validTimestamp(runtime.now())
  ) {
    throw validation("Signed grant is invalid.");
  }
  const row = requireReadyObject(
    runtime.metadata,
    tenantParameters(target.tenant),
    bucketName,
    objectPath,
  );
  if (row.version !== grant.claims.objectVersion) {
    throw validation("Signed grant is invalid.");
  }
  return row;
}

async function createResumableUpload(
  runtime: RuntimeOptions,
  context: TenantContext,
  input: Readonly<{
    bucketName: string;
    path: string;
    uploadLength: number;
    contentType: string;
    idempotencyKey: string;
    expiresAt: number;
  }>,
): Promise<ResumableUpload> {
  const bucketName = normalizeBucketName(input.bucketName);
  const objectPath = normalizeObjectPath(input.path);
  const uploadLength = nonNegativeLimit(input.uploadLength, "uploadLength");
  const contentType = normalizeContentType(input.contentType);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const timestamp = validTimestamp(runtime.now());
  if (uploadLength > runtime.maxObjectBytes) {
    throw quota("Object size limit was exceeded.");
  }
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= timestamp) {
    throw validation("Upload expiry is invalid.");
  }
  await authorize(runtime.policy, {
    context,
    action: "object:create",
    bucketName,
    objectPath,
  });
  const tenant = tenantParameters(context.tenant);
  const row = runtime.metadata.transaction((transaction) => {
    requireBucket(transaction, tenant, bucketName);
    transaction.execute({
      sql: `DELETE FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND expires_at <= ?
          AND state <> 'finalizing'`,
      parameters: [...tenant, timestamp],
    });
    const existing = findUploadByIdempotencyKey(transaction, tenant, idempotencyKey);
    if (existing !== null) {
      requireUploadOwner(existing, context);
      if (
        existing.bucket_name === bucketName &&
        existing.object_path === objectPath &&
        existing.upload_length === uploadLength &&
        existing.content_type === contentType
      ) {
        return existing;
      }
      throw conflict("Upload idempotency key was reused.");
    }
    if (
      findObject(transaction, tenant, bucketName, objectPath) !== null ||
      findObjectByIdempotencyKey(transaction, tenant, idempotencyKey) !== null ||
      findUploadByPath(transaction, tenant, bucketName, objectPath) !== null
    ) {
      throw conflict("Upload target or idempotency key is already in use.");
    }
    const usage = transaction.execute<{ sessions: number; bytes: number }>({
      sql: `SELECT COUNT(*) AS sessions, COALESCE(SUM(upload_length), 0) AS bytes
        FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND expires_at > ?`,
      parameters: [...tenant, timestamp],
    }).rows[0];
    if (usage === undefined) {
      throw infrastructure("Upload quota could not be read.");
    }
    if (
      usage.sessions >= runtime.maxUploadSessions ||
      usage.bytes + uploadLength > runtime.maxUploadBytes
    ) {
      throw quota("Resumable upload quota was exceeded.");
    }
    const uploadId = normalizeUploadId(runtime.createUploadId());
    transaction.execute({
      sql: `INSERT INTO storage_uploads (
          organization_id, project_id, environment_id, branch_id, generation,
          upload_id, actor_kind, actor_id, bucket_name, object_path, upload_length,
          upload_offset, content_type, idempotency_key, expires_at, state, body,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'uploading', ?, ?, ?)`,
      parameters: [
        ...tenant,
        uploadId,
        context.actor.kind,
        context.actor.id,
        bucketName,
        objectPath,
        uploadLength,
        contentType,
        idempotencyKey,
        input.expiresAt,
        new Uint8Array(),
        timestamp,
        timestamp,
      ],
    });
    return requireUpload(transaction, tenant, uploadId);
  });
  return toResumableUpload(row);
}

async function getResumableUpload(
  runtime: RuntimeOptions,
  context: TenantContext,
  uploadIdInput: string,
): Promise<ResumableUpload> {
  const uploadId = normalizeUploadId(uploadIdInput);
  const row = requireActiveUpload(runtime, context, uploadId);
  await authorize(runtime.policy, {
    context,
    action: "object:create",
    bucketName: row.bucket_name,
    objectPath: row.object_path,
  });
  return toResumableUpload(row);
}

async function appendResumableUpload(
  runtime: RuntimeOptions,
  context: TenantContext,
  uploadIdInput: string,
  offset: number,
  chunkInput: Uint8Array,
): Promise<ResumableUploadAppendResult> {
  const uploadId = normalizeUploadId(uploadIdInput);
  if (!Number.isSafeInteger(offset) || offset < 0 || !(chunkInput instanceof Uint8Array)) {
    throw validation("Upload append request is invalid.");
  }
  if (chunkInput.byteLength > runtime.maxUploadChunkBytes) {
    throw quota("Upload chunk size limit was exceeded.");
  }
  const chunk = Uint8Array.from(chunkInput);
  const initial = requireUpload(runtime.metadata, tenantParameters(context.tenant), uploadId);
  requireUploadOwner(initial, context);
  if (initial.expires_at <= validTimestamp(runtime.now()) && initial.state !== "finalizing") {
    throw notFound("Upload was not found.");
  }
  await authorize(runtime.policy, {
    context,
    action: "object:create",
    bucketName: initial.bucket_name,
    objectPath: initial.object_path,
  });
  const tenant = tenantParameters(context.tenant);
  const row = runtime.metadata.transaction((transaction) => {
    const current = requireUpload(transaction, tenant, uploadId);
    requireUploadOwner(current, context);
    if (current.expires_at <= validTimestamp(runtime.now()) && current.state !== "finalizing") {
      throw notFound("Upload was not found.");
    }
    if (current.state !== "uploading") {
      if (!isRetryOfFinalChunk(current, offset, chunk)) {
        throw conflict("Upload offset does not match.");
      }
      return current;
    }
    if (offset !== current.upload_offset) {
      throw conflict("Upload offset does not match.");
    }
    if (offset + chunk.byteLength > current.upload_length) {
      throw validation("Upload chunk exceeds the declared length.");
    }
    const body = new Uint8Array(current.body.byteLength + chunk.byteLength);
    body.set(current.body);
    body.set(chunk, current.body.byteLength);
    const nextOffset = offset + chunk.byteLength;
    const state: UploadState = nextOffset === current.upload_length ? "finalizing" : "uploading";
    transaction.execute({
      sql: `UPDATE storage_uploads SET upload_offset = ?, state = ?, body = ?, updated_at = ?
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND upload_id = ? AND upload_offset = ?`,
      parameters: [
        nextOffset,
        state,
        body,
        validTimestamp(runtime.now()),
        ...tenant,
        uploadId,
        offset,
      ],
    });
    return requireUpload(transaction, tenant, uploadId);
  });
  if (row.state === "uploading") {
    return Object.freeze({ upload: toResumableUpload(row), object: null });
  }
  const object = await putObject(runtime, context, {
    bucketName: row.bucket_name,
    path: row.object_path,
    body: Uint8Array.from(row.body),
    contentType: row.content_type,
    idempotencyKey: row.idempotency_key,
    resumableUploadId: row.upload_id,
  });
  const finalized = runtime.metadata.transaction((transaction) => {
    const update = transaction.execute({
      sql: `UPDATE storage_uploads SET state = 'complete', updated_at = ?
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND upload_id = ? AND state = 'finalizing'
          AND upload_offset = upload_length`,
      parameters: [validTimestamp(runtime.now()), ...tenant, uploadId],
    });
    const current = requireUpload(transaction, tenant, uploadId);
    requireUploadOwner(current, context);
    if (update.changes !== 1 && current.state !== "complete") {
      throw infrastructure("Object provider succeeded but upload finalization is pending.");
    }
    return current;
  });
  return Object.freeze({ upload: toResumableUpload(finalized), object });
}

async function abortResumableUpload(
  runtime: RuntimeOptions,
  context: TenantContext,
  uploadIdInput: string,
): Promise<void> {
  const uploadId = normalizeUploadId(uploadIdInput);
  const tenant = tenantParameters(context.tenant);
  const row = requireUpload(runtime.metadata, tenant, uploadId);
  requireUploadOwner(row, context);
  if (row.expires_at <= validTimestamp(runtime.now()) && row.state !== "finalizing") {
    throw notFound("Upload was not found.");
  }
  await authorize(runtime.policy, {
    context,
    action: "object:create",
    bucketName: row.bucket_name,
    objectPath: row.object_path,
  });
  runtime.metadata.transaction((transaction) => {
    const current = requireUpload(transaction, tenant, uploadId);
    requireUploadOwner(current, context);
    if (current.state === "finalizing") {
      throw conflict("Upload finalization is in progress.");
    }
    if (current.expires_at <= validTimestamp(runtime.now())) {
      throw notFound("Upload was not found.");
    }
    transaction.execute({
      sql: `DELETE FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND upload_id = ? AND state = ?`,
      parameters: [...tenant, uploadId, current.state],
    });
  });
}

function cleanupExpiredResumableUploads(runtime: RuntimeOptions): number {
  try {
    return runtime.metadata.execute({
      sql: "DELETE FROM storage_uploads WHERE expires_at <= ? AND state <> 'finalizing'",
      parameters: [validTimestamp(runtime.now())],
    }).changes;
  } catch (error) {
    if (isStorageAdapterFailure(error)) {
      throw new StorageCoreError(
        "STORAGE_CORE_INFRASTRUCTURE",
        "Storage metadata operation failed.",
        error.code === "STORAGE_BUSY",
      );
    }
    throw infrastructure("Storage metadata operation failed.");
  }
}

async function getObjectMetadata(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
  pathInput: string,
): Promise<StorageObjectMetadata> {
  const bucketName = normalizeBucketName(bucketNameInput);
  const objectPath = normalizeObjectPath(pathInput);
  await authorize(runtime.policy, {
    context,
    action: "object:read",
    bucketName,
    objectPath,
  });
  const row = findObject(
    runtime.metadata,
    tenantParameters(context.tenant),
    bucketName,
    objectPath,
  );
  if (row === null || row.state !== "ready") {
    throw notFound("Object was not found.");
  }
  return toObjectMetadata(row);
}

async function listObjects(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
  options: Readonly<{ prefix?: string; limit?: number }> = {},
): Promise<readonly StorageObjectMetadata[]> {
  const bucketName = normalizeBucketName(bucketNameInput);
  const prefix = options.prefix === undefined ? "" : normalizeObjectPrefix(options.prefix);
  const limit = options.limit ?? runtime.maxListResults;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > runtime.maxListResults) {
    throw validation(`Object list limit must be between 1 and ${runtime.maxListResults}.`);
  }
  await authorize(runtime.policy, { context, action: "object:list", bucketName });
  const tenant = tenantParameters(context.tenant);
  requireBucket(runtime.metadata, tenant, bucketName);
  const rows = runtime.metadata.execute<ObjectRow>({
    sql: `SELECT bucket_name, object_path, provider_key, state, size, content_type,
        checksum_sha256, provider_etag, version, idempotency_key, created_at, updated_at
      FROM storage_objects
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND bucket_name = ? AND state = 'ready'
        AND object_path LIKE ? ESCAPE '\\'
      ORDER BY object_path LIMIT ?`,
    parameters: [...tenant, bucketName, `${escapeLike(prefix)}%`, limit],
  }).rows;
  return Object.freeze(rows.map(toObjectMetadata));
}

async function getPolicySummary(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
): Promise<StoragePolicySummary> {
  const bucketName = normalizeBucketName(bucketNameInput);
  await authorize(runtime.policy, { context, action: "bucket:read", bucketName });
  requireBucket(runtime.metadata, tenantParameters(context.tenant), bucketName);
  const allowed = async (action: StoragePolicyAction): Promise<boolean> =>
    runtime.policy.authorize({ context, action, bucketName });
  const [
    canUpdateBucket,
    canDeleteBucket,
    canListObjects,
    canCreateObjects,
    canReadObjects,
    canDeleteObjects,
  ] = await Promise.all([
    allowed("bucket:update"),
    allowed("bucket:delete"),
    allowed("object:list"),
    allowed("object:create"),
    allowed("object:read"),
    allowed("object:delete"),
  ]);
  return Object.freeze({
    bucketName,
    canUpdateBucket,
    canDeleteBucket,
    canListObjects,
    canCreateObjects,
    canReadObjects,
    canDeleteObjects,
  });
}

async function deleteObject(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
  pathInput: string,
): Promise<void> {
  const bucketName = normalizeBucketName(bucketNameInput);
  const objectPath = normalizeObjectPath(pathInput);
  await authorize(runtime.policy, {
    context,
    action: "object:delete",
    bucketName,
    objectPath,
  });
  const tenant = tenantParameters(context.tenant);
  const row = runtime.metadata.transaction((transaction) => {
    const existing = findObject(transaction, tenant, bucketName, objectPath);
    if (existing === null) {
      return null;
    }
    if (existing.state === "pending_put") {
      throw conflict("Object creation is still pending.");
    }
    if (existing.state !== "pending_delete") {
      transaction.execute({
        sql: `UPDATE storage_objects SET state = 'pending_delete', updated_at = ?
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?`,
        parameters: [validTimestamp(runtime.now()), ...tenant, bucketName, objectPath],
      });
    }
    return existing;
  });
  if (row === null) {
    return;
  }
  try {
    await runtime.provider.delete(row.provider_key);
  } catch (error) {
    throw mapProviderError(error);
  }
  removeObjectRow(runtime.metadata, tenant, bucketName, objectPath, row.provider_key);
}

async function reconcileBucket(
  runtime: RuntimeOptions,
  context: TenantContext,
  bucketNameInput: string,
): Promise<ReconciliationReport> {
  const bucketName = normalizeBucketName(bucketNameInput);
  await authorize(runtime.policy, { context, action: "object:reconcile", bucketName });
  const tenant = tenantParameters(context.tenant);
  requireBucket(runtime.metadata, tenant, bucketName);
  const rows = listAllObjectRows(runtime.metadata, tenant, bucketName);
  const issues: ReconciliationIssue[] = [];
  let completedPuts = 0;
  let completedDeletes = 0;

  for (const row of rows) {
    if (row.state === "pending_delete") {
      try {
        await runtime.provider.delete(row.provider_key);
        removeObjectRow(runtime.metadata, tenant, bucketName, row.object_path, row.provider_key);
        completedDeletes += 1;
      } catch (error) {
        const mapped = mapProviderError(error);
        issues.push(
          issue("retry_delete", bucketName, row.object_path, row.provider_key, mapped.retryable),
        );
      }
      continue;
    }

    let providerMetadata: ObjectProviderMetadata | null;
    try {
      providerMetadata = await runtime.provider.head(row.provider_key);
    } catch (error) {
      const mapped = mapProviderError(error);
      issues.push(
        issue(
          row.state === "pending_put" ? "retry_put" : "provider_missing",
          bucketName,
          row.object_path,
          row.provider_key,
          mapped.retryable,
        ),
      );
      continue;
    }
    if (providerMetadata === null) {
      issues.push(
        issue(
          row.state === "pending_put" ? "retry_put" : "provider_missing",
          bucketName,
          row.object_path,
          row.provider_key,
          row.state === "pending_put",
        ),
      );
      continue;
    }
    if (
      providerMetadata.size !== row.size ||
      providerMetadata.checksumSha256 !== row.checksum_sha256
    ) {
      issues.push(issue("provider_mismatch", bucketName, row.object_path, row.provider_key, false));
      continue;
    }
    if (row.state === "pending_put") {
      const update = runtime.metadata.execute({
        sql: `UPDATE storage_objects SET state = 'ready', provider_etag = ?, updated_at = ?
          WHERE organization_id = ? AND project_id = ? AND environment_id = ?
            AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?
            AND provider_key = ? AND state = 'pending_put'`,
        parameters: [
          providerMetadata.etag,
          validTimestamp(runtime.now()),
          ...tenant,
          bucketName,
          row.object_path,
          row.provider_key,
        ],
      });
      if (update.changes === 1) {
        completedPuts += 1;
      }
    }
  }

  let providerObjects: readonly ObjectProviderMetadata[];
  try {
    providerObjects = await runtime.provider.list(
      createBucketProviderPrefix(context.tenant, bucketName),
    );
  } catch (error) {
    throw mapProviderError(error);
  }
  const knownKeys = new Set(
    listAllObjectRows(runtime.metadata, tenant, bucketName).map((row) => row.provider_key),
  );
  for (const providerObject of providerObjects) {
    if (!knownKeys.has(providerObject.key)) {
      issues.push(issue("orphan_provider_object", bucketName, null, providerObject.key, false));
    }
  }

  return Object.freeze({ completedPuts, completedDeletes, issues: Object.freeze(issues) });
}

function createBucketProviderPrefix(tenant: TenantIdentity, bucketName: string): string {
  return `${tenantProviderPrefix(tenant)}/buckets/${normalizeBucketName(bucketName)}/objects/`;
}

function createObjectProviderKey(
  tenant: TenantIdentity,
  bucketName: string,
  objectPath: string,
  version: string,
): string {
  return `${createBucketProviderPrefix(tenant, bucketName)}${normalizeObjectPath(
    objectPath,
  )}/versions/${normalizeVersion(version)}`;
}

export function normalizeStorageBucketName(value: string): string {
  return normalizeBucketName(value);
}

export function normalizeStorageObjectPath(value: string): string {
  return normalizeObjectPath(value);
}

export function normalizeStorageObjectPrefix(value: string): string {
  return normalizeObjectPrefix(value);
}

function initializeMetadata(metadata: StorageAdapter): void {
  metadata.transaction((transaction) => {
    transaction.execute({
      sql: `CREATE TABLE IF NOT EXISTS storage_metadata_schema (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version > 0)
      ) STRICT`,
    });
    const version = transaction.execute<{ version: number }>({
      sql: "SELECT version FROM storage_metadata_schema WHERE singleton = 1",
    }).rows[0]?.version;
    if (version === storageMetadataSchemaVersion) {
      return;
    }
    if (version === 1) {
      createUploadTable(transaction);
      transaction.execute({
        sql: "UPDATE storage_metadata_schema SET version = ? WHERE singleton = 1",
        parameters: [storageMetadataSchemaVersion],
      });
      return;
    }
    if (version !== undefined) {
      throw new StorageCoreError(
        "STORAGE_CORE_UNSUPPORTED",
        `Storage metadata schema version ${version} is not supported.`,
      );
    }

    createVersionOneTables(transaction);
    createUploadTable(transaction);
    transaction.execute({
      sql: "INSERT INTO storage_metadata_schema (singleton, version) VALUES (1, ?)",
      parameters: [storageMetadataSchemaVersion],
    });
  });
}

function createVersionOneTables(transaction: StorageExecutor): void {
  transaction.execute({
    sql: `CREATE TABLE IF NOT EXISTS storage_buckets (
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        name TEXT NOT NULL,
        is_public INTEGER NOT NULL CHECK (is_public IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (organization_id, project_id, environment_id, branch_id, generation, name)
      ) STRICT`,
  });
  transaction.execute({
    sql: `CREATE TABLE IF NOT EXISTS storage_objects (
        organization_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        bucket_name TEXT NOT NULL,
        object_path TEXT NOT NULL,
        provider_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('pending_put', 'ready', 'pending_delete')),
        size INTEGER NOT NULL CHECK (size >= 0),
        content_type TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL,
        provider_etag TEXT,
        version TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (
          organization_id, project_id, environment_id, branch_id, generation,
          bucket_name, object_path
        ),
        UNIQUE (
          organization_id, project_id, environment_id, branch_id, generation,
          idempotency_key
        ),
        FOREIGN KEY (
          organization_id, project_id, environment_id, branch_id, generation, bucket_name
        ) REFERENCES storage_buckets (
          organization_id, project_id, environment_id, branch_id, generation, name
        ) ON DELETE RESTRICT
      ) STRICT`,
  });
}

function createUploadTable(transaction: StorageExecutor): void {
  transaction.execute({
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
      ),
      FOREIGN KEY (
        organization_id, project_id, environment_id, branch_id, generation, bucket_name
      ) REFERENCES storage_buckets (
        organization_id, project_id, environment_id, branch_id, generation, name
      ) ON DELETE RESTRICT
    ) STRICT`,
  });
}

function findBucket(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  name: string,
): BucketRow | null {
  return (
    executor.execute<BucketRow>({
      sql: `SELECT name, is_public, created_at, updated_at FROM storage_buckets
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND name = ?`,
      parameters: [...tenant, name],
    }).rows[0] ?? null
  );
}

function requireBucket(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  name: string,
): void {
  if (findBucket(executor, tenant, name) === null) {
    throw notFound("Bucket was not found.");
  }
}

function findObject(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  bucketName: string,
  objectPath: string,
): ObjectRow | null {
  return (
    executor.execute<ObjectRow>({
      sql: `SELECT bucket_name, object_path, provider_key, state, size, content_type,
          checksum_sha256, provider_etag, version, idempotency_key, created_at, updated_at
        FROM storage_objects
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?`,
      parameters: [...tenant, bucketName, objectPath],
    }).rows[0] ?? null
  );
}

function findObjectByIdempotencyKey(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  idempotencyKey: string,
): ObjectRow | null {
  return (
    executor.execute<ObjectRow>({
      sql: `SELECT bucket_name, object_path, provider_key, state, size, content_type,
          checksum_sha256, provider_etag, version, idempotency_key, created_at, updated_at
        FROM storage_objects
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND idempotency_key = ?`,
      parameters: [...tenant, idempotencyKey],
    }).rows[0] ?? null
  );
}

function requireReadyObject(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  bucketName: string,
  objectPath: string,
): ObjectRow {
  const row = findObject(executor, tenant, bucketName, objectPath);
  if (row === null || row.state !== "ready") {
    throw notFound("Object was not found.");
  }
  return row;
}

async function readObject(runtime: RuntimeOptions, row: ObjectRow): Promise<StorageObject> {
  let result: ObjectProviderGetResult | null;
  try {
    result = await runtime.provider.get(
      row.provider_key,
      Math.min(row.size, runtime.maxObjectBytes),
    );
  } catch (error) {
    throw mapProviderError(error);
  }
  if (result === null) {
    throw notFound("Object was not found.");
  }
  const body = Uint8Array.from(result.body);
  const actualChecksum = createHash("sha256").update(body).digest("hex");
  if (
    result.metadata.key !== row.provider_key ||
    result.metadata.size !== row.size ||
    body.byteLength !== row.size ||
    result.metadata.checksumSha256 !== row.checksum_sha256 ||
    actualChecksum !== row.checksum_sha256
  ) {
    throw infrastructure("Stored object verification failed.");
  }
  return Object.freeze({ metadata: toObjectMetadata(row), body });
}

function findUpload(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  uploadId: string,
): UploadRow | null {
  return (
    executor.execute<UploadRow>({
      sql: `SELECT upload_id, actor_kind, actor_id, bucket_name, object_path,
          upload_length, upload_offset, content_type, idempotency_key, expires_at,
          state, body, created_at, updated_at
        FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND upload_id = ?`,
      parameters: [...tenant, uploadId],
    }).rows[0] ?? null
  );
}

function requireUpload(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  uploadId: string,
): UploadRow {
  const row = findUpload(executor, tenant, uploadId);
  if (row === null) {
    throw notFound("Upload was not found.");
  }
  return row;
}

function findUploadByIdempotencyKey(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  idempotencyKey: string,
): UploadRow | null {
  return (
    executor.execute<UploadRow>({
      sql: `SELECT upload_id, actor_kind, actor_id, bucket_name, object_path,
          upload_length, upload_offset, content_type, idempotency_key, expires_at,
          state, body, created_at, updated_at
        FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND idempotency_key = ?`,
      parameters: [...tenant, idempotencyKey],
    }).rows[0] ?? null
  );
}

function findUploadByPath(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  bucketName: string,
  objectPath: string,
): UploadRow | null {
  return (
    executor.execute<UploadRow>({
      sql: `SELECT upload_id, actor_kind, actor_id, bucket_name, object_path,
          upload_length, upload_offset, content_type, idempotency_key, expires_at,
          state, body, created_at, updated_at
        FROM storage_uploads
        WHERE organization_id = ? AND project_id = ? AND environment_id = ?
          AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?`,
      parameters: [...tenant, bucketName, objectPath],
    }).rows[0] ?? null
  );
}

function requireActiveUpload(
  runtime: RuntimeOptions,
  context: TenantContext,
  uploadId: string,
): UploadRow {
  const row = requireUpload(runtime.metadata, tenantParameters(context.tenant), uploadId);
  requireUploadOwner(row, context);
  if (row.expires_at <= validTimestamp(runtime.now())) {
    throw notFound("Upload was not found.");
  }
  return row;
}

function requireUploadOwner(row: UploadRow, context: TenantContext): void {
  if (row.actor_kind !== context.actor.kind || row.actor_id !== context.actor.id) {
    throw notFound("Upload was not found.");
  }
}

function isRetryOfFinalChunk(row: UploadRow, offset: number, chunk: Uint8Array): boolean {
  if (offset === row.upload_length && chunk.byteLength === 0) {
    return true;
  }
  if (offset < 0 || offset + chunk.byteLength !== row.upload_length) {
    return false;
  }
  const stored = row.body.subarray(offset);
  if (stored.byteLength !== chunk.byteLength) {
    return false;
  }
  return stored.every((value, index) => value === chunk[index]);
}

function isConflictingUploadReservation(row: UploadRow | null, uploadId?: string): boolean {
  return row !== null && (row.upload_id !== uploadId || row.state !== "finalizing");
}

function listAllObjectRows(
  executor: StorageExecutor,
  tenant: readonly StorageValue[],
  bucketName: string,
): readonly ObjectRow[] {
  return executor.execute<ObjectRow>({
    sql: `SELECT bucket_name, object_path, provider_key, state, size, content_type,
        checksum_sha256, provider_etag, version, idempotency_key, created_at, updated_at
      FROM storage_objects
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND bucket_name = ? ORDER BY object_path`,
    parameters: [...tenant, bucketName],
  }).rows;
}

function removeObjectRow(
  metadata: StorageAdapter,
  tenant: readonly StorageValue[],
  bucketName: string,
  objectPath: string,
  providerKey: string,
): void {
  metadata.execute({
    sql: `DELETE FROM storage_objects
      WHERE organization_id = ? AND project_id = ? AND environment_id = ?
        AND branch_id = ? AND generation = ? AND bucket_name = ? AND object_path = ?
        AND provider_key = ? AND state = 'pending_delete'`,
    parameters: [...tenant, bucketName, objectPath, providerKey],
  });
}

async function authorize(policy: StoragePolicyHook, request: StoragePolicyRequest): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await policy.authorize(request);
  } catch {
    throw infrastructure("Storage policy evaluation failed.");
  }
  if (allowed !== true) {
    throw new StorageCoreError("STORAGE_CORE_FORBIDDEN", "Storage operation is not permitted.");
  }
}

function tenantParameters(tenant: TenantIdentity): readonly StorageValue[] {
  return Object.freeze([
    tenant.organizationId,
    tenant.projectId,
    tenant.environmentId,
    tenant.branchId,
    tenant.generation,
  ]);
}

function tenantProviderPrefix(tenant: TenantIdentity): string {
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
  ].join("/");
}

function normalizeBucketName(value: string): string {
  if (typeof value !== "string" || !bucketNamePattern.test(value)) {
    throw validation("Bucket name must be a lowercase DNS-style name between 3 and 63 characters.");
  }
  return value;
}

function normalizeObjectPath(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) {
    throw validation("Object path must contain between 1 and 1024 characters.");
  }
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    hasUnpairedSurrogate(value)
  ) {
    throw validation("Object path is not valid.");
  }
  if (Buffer.byteLength(value, "utf8") > storageObjectPathMaxUtf8Bytes) {
    throw validation(`Object path must not exceed ${storageObjectPathMaxUtf8Bytes} UTF-8 bytes.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        hasForbiddenControlCharacter(segment) ||
        Buffer.byteLength(segment, "utf8") > storageObjectPathSegmentMaxUtf8Bytes,
    )
  ) {
    throw validation("Object path contains a forbidden segment.");
  }
  return segments.join("/");
}

function normalizeObjectPrefix(value: string): string {
  if (value === "") {
    return value;
  }
  return value.endsWith("/")
    ? `${normalizeObjectPath(value.slice(0, -1))}/`
    : normalizeObjectPath(value);
}

function normalizeContentType(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.includes("\0")
  ) {
    throw validation("Content type is not valid.");
  }
  return value;
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || !idempotencyKeyPattern.test(value)) {
    throw validation("Idempotency key is not valid.");
  }
  return value;
}

function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeVersion(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw validation("Object version is not valid.");
  }
  return value;
}

function normalizeUploadId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw validation("Upload identifier is not valid.");
  }
  return value;
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validation(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw validation(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw infrastructure("Storage clock returned an invalid timestamp.");
  }
  return value;
}

function verifyProviderMetadata(
  metadata: ObjectProviderMetadata,
  row: ObjectRow,
  expectedSize: number,
): void {
  if (
    metadata.key !== row.provider_key ||
    metadata.size !== expectedSize ||
    metadata.checksumSha256 !== row.checksum_sha256 ||
    !/^[a-f0-9]{64}$/.test(metadata.checksumSha256)
  ) {
    throw infrastructure("Object provider returned inconsistent metadata.");
  }
}

function toBucket(row: BucketRow): StorageBucket {
  return Object.freeze({
    name: row.name,
    isPublic: row.is_public === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toObjectMetadata(row: ObjectRow): StorageObjectMetadata {
  return Object.freeze({
    bucketName: row.bucket_name,
    path: row.object_path,
    size: row.size,
    contentType: row.content_type,
    checksumSha256: row.checksum_sha256,
    providerEtag: row.provider_etag,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toResumableUpload(row: UploadRow): ResumableUpload {
  return Object.freeze({
    id: row.upload_id,
    bucketName: row.bucket_name,
    path: row.object_path,
    uploadLength: row.upload_length,
    offset: row.upload_offset,
    contentType: row.content_type,
    idempotencyKey: row.idempotency_key,
    expiresAt: row.expires_at,
    complete: row.state === "complete",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function requireSignedReadGrantAuthority(runtime: RuntimeOptions): SignedReadGrantAuthority {
  if (runtime.signedReadGrants === null) {
    throw new StorageCoreError("STORAGE_CORE_UNSUPPORTED", "Signed grants are not configured.");
  }
  return runtime.signedReadGrants;
}

function sameTenant(left: TenantIdentity, right: TenantIdentity): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.branchId === right.branchId &&
    left.generation === right.generation
  );
}

function issue(
  kind: ReconciliationIssue["kind"],
  bucketName: string,
  objectPath: string | null,
  providerKey: string,
  retryable: boolean,
): ReconciliationIssue {
  return Object.freeze({ kind, bucketName, objectPath, providerKey, retryable });
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function mapProviderError(error: unknown): StorageCoreError {
  if (error instanceof StorageCoreError) {
    return error;
  }
  if (error instanceof ObjectProviderError) {
    return new StorageCoreError(
      "STORAGE_CORE_INFRASTRUCTURE",
      "Object provider operation failed.",
      error.retryable,
    );
  }
  return infrastructure("Object provider operation failed.");
}

async function runCoreOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StorageCoreError) {
      throw error;
    }
    if (isStorageAdapterFailure(error)) {
      throw new StorageCoreError(
        "STORAGE_CORE_INFRASTRUCTURE",
        "Storage metadata operation failed.",
        error.code === "STORAGE_BUSY",
      );
    }
    throw new StorageCoreError(
      "STORAGE_CORE_INFRASTRUCTURE",
      "Storage core operation failed.",
      false,
    );
  }
}

function isStorageAdapterFailure(error: unknown): error is Readonly<{ code: string }> {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "StorageAdapterError" &&
    "code" in error &&
    typeof error.code === "string"
  );
}

function validation(message: string): StorageCoreError {
  return new StorageCoreError("STORAGE_CORE_VALIDATION", message);
}

function notFound(message: string): StorageCoreError {
  return new StorageCoreError("STORAGE_CORE_NOT_FOUND", message);
}

function conflict(message: string): StorageCoreError {
  return new StorageCoreError("STORAGE_CORE_CONFLICT", message);
}

function quota(message: string): StorageCoreError {
  return new StorageCoreError("STORAGE_CORE_QUOTA", message);
}

function infrastructure(message: string): StorageCoreError {
  return new StorageCoreError("STORAGE_CORE_INFRASTRUCTURE", message, true);
}
