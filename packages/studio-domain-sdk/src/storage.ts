import {
  createCorrelationId,
  parseTenantIdentity,
  serializeTenantIdentity,
  type TenantIdentity,
  type TenantIdentityInput,
  tenantHeaders,
} from "@mekka/protocol";
import { type StudioCredential, StudioDomainError } from "./index";

export type StudioStorageBucket = Readonly<{
  name: string;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
}>;

export type StudioStorageObject = Readonly<{
  bucketName: string;
  path: string;
  size: number;
  contentType: string;
  checksumSha256: string;
  version: string;
  createdAt: number;
  updatedAt: number;
}>;

export type StudioStoragePolicySummary = Readonly<{
  bucketName: string;
  canUpdateBucket: boolean;
  canDeleteBucket: boolean;
  canListObjects: boolean;
  canCreateObjects: boolean;
  canReadObjects: boolean;
  canDeleteObjects: boolean;
}>;

export type StudioStorageUploadProgress = Readonly<{
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  state: "uploading" | "retrying" | "complete";
}>;

export type StudioStorageUploadFile = Readonly<{
  size: number;
  type: string;
  slice(start?: number, end?: number): Blob;
}>;

export type StudioStorageClient = Readonly<{
  listBuckets(
    input?: Readonly<{ search?: string; signal?: AbortSignal }>,
  ): Promise<readonly StudioStorageBucket[]>;
  getBucket(name: string, input?: Readonly<{ signal?: AbortSignal }>): Promise<StudioStorageBucket>;
  createBucket(name: string, idempotencyKey: string): Promise<StudioStorageBucket>;
  updateBucket(
    name: string,
    isPublic: boolean,
    idempotencyKey: string,
  ): Promise<StudioStorageBucket>;
  deleteBucket(name: string, idempotencyKey: string): Promise<void>;
  listObjects(
    bucketName: string,
    input?: Readonly<{ prefix?: string; signal?: AbortSignal }>,
  ): Promise<readonly StudioStorageObject[]>;
  getPolicySummary(
    bucketName: string,
    input?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<StudioStoragePolicySummary>;
  uploadObject(
    bucketName: string,
    path: string,
    file: StudioStorageUploadFile,
    input: Readonly<{
      idempotencyKey: string;
      signal?: AbortSignal;
      onProgress?: (progress: StudioStorageUploadProgress) => void;
    }>,
  ): Promise<StudioStorageObject>;
  createSignedDownload(
    bucketName: string,
    path: string,
    input?: Readonly<{ expiresIn?: number; signal?: AbortSignal }>,
  ): Promise<Readonly<{ signedUrl: string; expiresAt: number }>>;
  deleteObject(bucketName: string, path: string, idempotencyKey: string): Promise<void>;
}>;

const chunkSize = 1024 * 1024;

export function createStudioStorageClient(
  input: Readonly<{
    baseUrl: string;
    tenant: TenantIdentity | TenantIdentityInput;
    getCredential?: () =>
      | Promise<Extract<StudioCredential, { kind: "session" }> | undefined>
      | Extract<StudioCredential, { kind: "session" }>
      | undefined;
    getCsrfToken: () => Promise<string> | string;
    fetch?: typeof globalThis.fetch;
  }>,
): StudioStorageClient {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  const tenant = parseTenantIdentity(input.tenant);
  const fetcher = input.fetch ?? globalThis.fetch;
  const send = (path: string, init: RequestInit = {}, isMutation = false) =>
    storageRequest(
      fetcher,
      baseUrl,
      tenant,
      input.getCredential,
      input.getCsrfToken,
      path,
      init,
      isMutation,
    );

  return Object.freeze({
    async listBuckets(options = {}) {
      const query = new URLSearchParams();
      if (options.search?.trim()) query.set("search", options.search.trim());
      const body = await readJson(
        await send(`buckets${query.size > 0 ? `?${query}` : ""}`, requestSignal(options.signal)),
      );
      return Object.freeze(readArray(readRecord(body).buckets, 100).map(parseBucket));
    },
    async getBucket(name, options = {}) {
      assertBucketName(name);
      return parseBucket(
        await readJson(
          await send(`buckets/${encodeURIComponent(name)}`, requestSignal(options.signal)),
        ),
      );
    },
    async createBucket(name, idempotencyKey) {
      assertBucketName(name);
      assertIdempotencyKey(idempotencyKey);
      return parseBucket(
        await readJson(
          await send(
            "buckets",
            jsonMutation("POST", { name, isPublic: false }, idempotencyKey),
            true,
          ),
        ),
      );
    },
    async updateBucket(name, isPublic, idempotencyKey) {
      assertBucketName(name);
      assertIdempotencyKey(idempotencyKey);
      return parseBucket(
        await readJson(
          await send(
            `buckets/${encodeURIComponent(name)}`,
            jsonMutation("PATCH", { isPublic }, idempotencyKey),
            true,
          ),
        ),
      );
    },
    async deleteBucket(name, idempotencyKey) {
      assertBucketName(name);
      assertIdempotencyKey(idempotencyKey);
      await expectEmpty(
        await send(
          `buckets/${encodeURIComponent(name)}`,
          { method: "DELETE", headers: { "idempotency-key": idempotencyKey } },
          true,
        ),
      );
    },
    async listObjects(bucketName, options = {}) {
      assertBucketName(bucketName);
      const query = new URLSearchParams();
      if (options.prefix) query.set("prefix", options.prefix);
      const response = await send(
        `buckets/${encodeURIComponent(bucketName)}/objects${query.size > 0 ? `?${query}` : ""}`,
        requestSignal(options.signal),
      );
      return Object.freeze(
        readArray(readRecord(await readJson(response)).objects, 100).map(parseObject),
      );
    },
    async getPolicySummary(bucketName, options = {}) {
      assertBucketName(bucketName);
      return parsePolicySummary(
        await readJson(
          await send(
            `buckets/${encodeURIComponent(bucketName)}/policy-summary`,
            requestSignal(options.signal),
          ),
        ),
      );
    },
    async uploadObject(bucketName, path, file, options) {
      assertBucketName(bucketName);
      assertObjectPath(path);
      assertIdempotencyKey(options.idempotencyKey);
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw validationError();
      if (file.size <= chunkSize) {
        const response = await send(
          `object/${encodeURIComponent(bucketName)}/${encodePath(path)}`,
          {
            method: "PUT",
            body: file.slice(0, file.size),
            headers: {
              "content-type": file.type || "application/octet-stream",
              "idempotency-key": options.idempotencyKey,
            },
            ...requestSignal(options.signal),
          },
          true,
        );
        const object = parseObject(await readJson(response));
        options.onProgress?.({
          uploadedBytes: file.size,
          totalBytes: file.size,
          percentage: 100,
          state: "complete",
        });
        return object;
      }
      return resumableUpload(send, bucketName, path, file, options);
    },
    async createSignedDownload(bucketName, path, options = {}) {
      assertBucketName(bucketName);
      assertObjectPath(path);
      const record = readRecord(
        await readJson(
          await send(
            `object/sign/${encodeURIComponent(bucketName)}/${encodePath(path)}`,
            jsonMutation(
              "POST",
              { expiresIn: options.expiresIn ?? 300 },
              `sign-${crypto.randomUUID()}`,
              options.signal,
            ),
            true,
          ),
        ),
      );
      const signedUrl = readString(record.signedUrl, 4096);
      const expiresAt = readInteger(record.expiresAt);
      const parsed = new URL(signedUrl);
      if (
        parsed.protocol !== "https:" &&
        !(
          parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
        )
      ) {
        throw malformedResponse();
      }
      return Object.freeze({ signedUrl, expiresAt });
    },
    async deleteObject(bucketName, path, idempotencyKey) {
      assertBucketName(bucketName);
      assertObjectPath(path);
      assertIdempotencyKey(idempotencyKey);
      await expectEmpty(
        await send(
          `object/${encodeURIComponent(bucketName)}/${encodePath(path)}`,
          { method: "DELETE", headers: { "idempotency-key": idempotencyKey } },
          true,
        ),
      );
    },
  });
}

async function resumableUpload(
  send: (path: string, init?: RequestInit, isMutation?: boolean) => Promise<Response>,
  bucketName: string,
  path: string,
  file: StudioStorageUploadFile,
  options: Readonly<{
    idempotencyKey: string;
    signal?: AbortSignal;
    onProgress?: (progress: StudioStorageUploadProgress) => void;
  }>,
): Promise<StudioStorageObject> {
  const metadata = globalThis.btoa("application/octet-stream");
  const created = await send(
    `resumable/${encodeURIComponent(bucketName)}/${encodePath(path)}`,
    {
      method: "POST",
      headers: {
        "idempotency-key": options.idempotencyKey,
        "tus-resumable": "1.0.0",
        "upload-length": String(file.size),
        "upload-metadata": `contentType ${metadata}`,
      },
      ...requestSignal(options.signal),
    },
    true,
  );
  const location = created.headers.get("location");
  if (location === null) throw malformedResponse();
  const uploadId = new URL(location).pathname.split("/").at(-1);
  if (!uploadId || !/^[A-Za-z0-9_-]{3,128}$/.test(uploadId)) throw malformedResponse();
  let offset = readHeaderInteger(created.headers, "upload-offset");
  upload: while (offset < file.size) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const end = Math.min(offset + chunkSize, file.size);
        const chunk = file.slice(offset, end);
        response = await send(
          `resumable/${encodeURIComponent(uploadId)}`,
          {
            method: "PATCH",
            headers: {
              "content-type": "application/offset+octet-stream",
              "tus-resumable": "1.0.0",
              "upload-offset": String(offset),
            },
            body: chunk,
            ...requestSignal(options.signal),
          },
          true,
        );
        break;
      } catch (error) {
        if (options.signal?.aborted || attempt === 2) throw error;
        options.onProgress?.({
          uploadedBytes: offset,
          totalBytes: file.size,
          percentage: Math.floor((offset / file.size) * 100),
          state: "retrying",
        });
        const head = await send(`resumable/${encodeURIComponent(uploadId)}`, {
          method: "HEAD",
          headers: { "tus-resumable": "1.0.0" },
          ...requestSignal(options.signal),
        });
        offset = readHeaderInteger(head.headers, "upload-offset");
        if (offset === file.size) break upload;
      }
    }
    if (response === undefined) throw malformedResponse();
    offset = readHeaderInteger(response.headers, "upload-offset");
    options.onProgress?.({
      uploadedBytes: offset,
      totalBytes: file.size,
      percentage: Math.floor((offset / file.size) * 100),
      state: offset === file.size ? "complete" : "uploading",
    });
  }
  const objects = await readJson(
    await send(
      `buckets/${encodeURIComponent(bucketName)}/objects?prefix=${encodeURIComponent(path)}`,
    ),
  );
  const object = readArray(readRecord(objects).objects, 100)
    .map(parseObject)
    .find((item) => item.path === path);
  if (!object) throw malformedResponse();
  return object;
}

async function storageRequest(
  fetcher: typeof globalThis.fetch,
  baseUrl: string,
  tenant: TenantIdentity,
  getCredential:
    | (() =>
        | Promise<Extract<StudioCredential, { kind: "session" }> | undefined>
        | Extract<StudioCredential, { kind: "session" }>
        | undefined)
    | undefined,
  getCsrfToken: () => Promise<string> | string,
  path: string,
  init: RequestInit,
  isMutation: boolean,
): Promise<Response> {
  const correlationId = createCorrelationId();
  const serialized = serializeTenantIdentity(tenant);
  const headers = new Headers(init.headers);
  headers.set(tenantHeaders.organizationId, serialized.organizationId);
  headers.set(tenantHeaders.projectId, serialized.projectId);
  headers.set(tenantHeaders.environmentId, serialized.environmentId);
  headers.set(tenantHeaders.branchId, serialized.branchId);
  headers.set(tenantHeaders.generation, String(serialized.generation));
  headers.set(tenantHeaders.correlationId, correlationId);
  headers.set("accept", "application/json");
  const credential = await getCredential?.();
  if (!credential || credential.token.length < 8 || credential.token.length > 8192)
    throw new StudioDomainError("auth", 401, correlationId);
  headers.set("authorization", `Bearer ${credential.token}`);
  if (isMutation) headers.set("x-mekka-csrf-token", await getCsrfToken());
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/${path}`, { ...init, credentials: "include", headers });
  } catch (error) {
    if (init.signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
      throw error;
    throw new StudioDomainError("infrastructure", 503, correlationId);
  }
  if (!response.ok) {
    let code: StudioDomainError["code"] = "infrastructure";
    try {
      const error = readRecord(readRecord(await response.clone().json()).error);
      const value = error.code;
      if (
        value === "validation" ||
        value === "auth" ||
        value === "forbidden" ||
        value === "conflict" ||
        value === "quota" ||
        value === "unsupported" ||
        value === "infrastructure"
      )
        code = value;
    } catch {}
    throw new StudioDomainError(code, response.status, correlationId);
  }
  return response;
}

function jsonMutation(
  method: "POST" | "PATCH",
  body: unknown,
  idempotencyKey: string,
  signal?: AbortSignal,
): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    ...(signal ? { signal } : {}),
  };
}

function requestSignal(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024) throw malformedResponse();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw malformedResponse();
  }
}

async function expectEmpty(response: Response): Promise<void> {
  if ((await response.arrayBuffer()).byteLength !== 0) throw malformedResponse();
}

function parseBucket(value: unknown): StudioStorageBucket {
  const record = readRecord(value);
  return Object.freeze({
    name: readBucketName(record.name),
    isPublic: readBoolean(record.isPublic),
    createdAt: readInteger(record.createdAt),
    updatedAt: readInteger(record.updatedAt),
  });
}

function parseObject(value: unknown): StudioStorageObject {
  const record = readRecord(value);
  const path = readString(record.path, 384);
  return Object.freeze({
    bucketName: readBucketName(record.bucketName),
    path,
    size: readInteger(record.size),
    contentType: readString(record.contentType, 256),
    checksumSha256: readHash(record.checksumSha256),
    version: readString(record.version, 128),
    createdAt: readInteger(record.createdAt),
    updatedAt: readInteger(record.updatedAt),
  });
}

function parsePolicySummary(value: unknown): StudioStoragePolicySummary {
  const record = readRecord(value);
  return Object.freeze({
    bucketName: readBucketName(record.bucketName),
    canUpdateBucket: readBoolean(record.canUpdateBucket),
    canDeleteBucket: readBoolean(record.canDeleteBucket),
    canListObjects: readBoolean(record.canListObjects),
    canCreateObjects: readBoolean(record.canCreateObjects),
    canReadObjects: readBoolean(record.canReadObjects),
    canDeleteObjects: readBoolean(record.canDeleteObjects),
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw malformedResponse();
  return value as Record<string, unknown>;
}
function readArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw malformedResponse();
  return value;
}
function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw malformedResponse();
  return value;
}
function readInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw malformedResponse();
  return value;
}
function readString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    throw malformedResponse();
  return value;
}
function readHash(value: unknown): string {
  const hash = readString(value, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw malformedResponse();
  return hash;
}
function readBucketName(value: unknown): string {
  const name = readString(value, 63);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(name)) throw malformedResponse();
  return name;
}
function readHeaderInteger(headers: Headers, name: string): number {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) throw malformedResponse();
  return readInteger(Number(value));
}
function assertBucketName(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value)) throw validationError();
}
function assertObjectPath(value: string): void {
  if (
    !value ||
    value.length > 384 ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw validationError();
}
function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw validationError();
}
function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
function validationError(): StudioDomainError {
  return new StudioDomainError("validation", 400, createCorrelationId());
}
function malformedResponse(): StudioDomainError {
  return new StudioDomainError("infrastructure", 503, createCorrelationId());
}
