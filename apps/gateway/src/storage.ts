import { createHash, timingSafeEqual } from "node:crypto";
import {
  createErrorEnvelope,
  hasCapability,
  ProtocolError,
  parseTenantIdentity,
  parseTenantIdentityFromHeaders,
  resolveCorrelationId,
  type TenantContext,
  type TenantIdentity,
} from "@mekka/protocol";
import {
  StorageCoreError,
  type StorageObject,
  type StorageObjectMetadata,
} from "@mekka/storage-core";
import { Elysia } from "elysia";
import type { GatewayDependencies, GatewayLimits, GatewayMetric, RestProject } from "./app";

const jsonBodyLimit = 8 * 1024;
const tusVersion = "1.0.0";
const checksumPattern = /^[a-f0-9]{64}$/;

export function createStorageRoutes(
  dependencies: GatewayDependencies,
  limits: GatewayLimits,
  now: () => number,
) {
  const publicOrigin = normalizePublicOrigin(dependencies.storagePublicOrigin);
  const routes = new Elysia({ name: "gateway-storage" });

  routes.get("/storage/v1/buckets", ({ request }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      const search = new URL(request.url).searchParams.get("search")?.trim().toLowerCase() ?? "";
      if (search.length > 63) throw new StorageHttpError("validation", 400);
      const buckets = await project.objectStorage.listBuckets(context);
      return jsonResponse(
        { buckets: buckets.filter((bucket) => bucket.name.includes(search)) },
        context.correlationId,
      );
    }),
  );

  routes.post("/storage/v1/buckets", ({ request }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireStorageAdmin(context, now());
      requireJsonContentType(request.headers);
      requireIdempotencyKey(request.headers);
      const input = parseBucketMutation(await readBoundedBody(request, jsonBodyLimit), true);
      const bucket = await project.objectStorage.createBucket(context, input);
      await recordAudit(dependencies, context, "storage.bucket.create", bucket.name);
      return jsonResponse(bucket, context.correlationId, 201);
    }),
  );

  routes.get("/storage/v1/buckets/:bucket", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) =>
      jsonResponse(
        await project.objectStorage.getBucket(context, params.bucket),
        context.correlationId,
      ),
    ),
  );

  routes.patch("/storage/v1/buckets/:bucket", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireStorageAdmin(context, now());
      requireJsonContentType(request.headers);
      requireIdempotencyKey(request.headers);
      const input = parseBucketMutation(await readBoundedBody(request, jsonBodyLimit), false);
      const bucket = await project.objectStorage.updateBucket(context, params.bucket, input);
      await recordAudit(dependencies, context, "storage.bucket.update", bucket.name);
      return jsonResponse(bucket, context.correlationId);
    }),
  );

  routes.delete("/storage/v1/buckets/:bucket", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireStorageAdmin(context, now());
      requireIdempotencyKey(request.headers);
      await project.objectStorage.deleteBucket(context, params.bucket);
      await recordAudit(dependencies, context, "storage.bucket.delete", params.bucket);
      return emptyResponse(context.correlationId);
    }),
  );

  routes.get("/storage/v1/buckets/:bucket/objects", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      const query = new URL(request.url).searchParams;
      const prefix = query.get("prefix") ?? undefined;
      const objects = await project.objectStorage.listObjects(context, params.bucket, {
        ...(prefix === undefined || prefix === "" ? {} : { prefix }),
        limit: 100,
      });
      return jsonResponse({ objects: objects.map(publicObjectMetadata) }, context.correlationId);
    }),
  );

  routes.get("/storage/v1/buckets/:bucket/policy-summary", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireStorageAdmin(context, now());
      return jsonResponse(
        await project.objectStorage.getPolicySummary(context, params.bucket),
        context.correlationId,
      );
    }),
  );

  routes.put("/storage/v1/object/:bucket/*", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      const path = validateObjectPath(params["*"]);
      const contentType = parseObjectContentType(request.headers);
      const idempotencyKey = requireIdempotencyKey(request.headers);
      const body = await readBoundedBody(request, limits.maxObjectBytes);
      verifyClientChecksum(request.headers, body);
      verifyMime(contentType, body);
      const metadata = await project.objectStorage.putObject(context, {
        bucketName: params.bucket,
        path,
        body,
        contentType,
        idempotencyKey,
      });
      await recordAudit(dependencies, context, "storage.object.create", params.bucket, path);
      return metadataResponse(metadata, context.correlationId);
    }),
  );

  routes.get("/storage/v1/object/:bucket/*", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      const path = validateObjectPath(params["*"]);
      const metadata = await project.objectStorage.getObjectMetadata(context, params.bucket, path);
      const notModified = notModifiedResponse(
        metadata,
        request.headers,
        context.correlationId,
        "private",
      );
      if (notModified !== null) {
        return notModified;
      }
      const object = await project.objectStorage.getObject(context, params.bucket, path);
      return objectResponse(object, request.headers, context.correlationId, "private");
    }),
  );

  routes.delete("/storage/v1/object/:bucket/*", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireIdempotencyKey(request.headers);
      const path = validateObjectPath(params["*"]);
      await project.objectStorage.deleteObject(context, params.bucket, path);
      await recordAudit(dependencies, context, "storage.object.delete", params.bucket, path);
      return new Response(null, {
        status: 204,
        headers: { "x-correlation-id": context.correlationId },
      });
    }),
  );

  routes.post("/storage/v1/object/sign/:bucket/*", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireJsonContentType(request.headers);
      const input = parseSignInput(await readBoundedBody(request, jsonBodyLimit));
      if (input.expiresIn > limits.maxSignedUrlTtlSeconds) {
        throw new StorageHttpError("validation", 400);
      }
      const expiresAt = checkedTimestamp(now(), input.expiresIn * 1_000);
      const path = validateObjectPath(params["*"]);
      const token = await project.objectStorage.issueReadGrant(
        context,
        params.bucket,
        path,
        expiresAt,
      );
      await recordAudit(dependencies, context, "storage.object.sign", params.bucket, path);
      const signedUrl = new URL(
        `/storage/v1/signed/${encodeURIComponent(params.bucket)}/${encodeObjectPath(path)}`,
        publicOrigin,
      );
      signedUrl.searchParams.set("token", token);
      setTenantQuery(signedUrl, context.tenant);
      return Response.json(
        { signedUrl: signedUrl.toString(), expiresAt },
        {
          status: 200,
          headers: { "x-correlation-id": context.correlationId },
        },
      );
    }),
  );

  routes.get("/storage/v1/signed/:bucket/*", ({ request, params }) =>
    handleSignedRequest(request, dependencies, now, async (tenant, project) => {
      let object: StorageObject;
      let expiresAt: number;
      try {
        const url = new URL(request.url);
        const token = requireSingleQueryParameter(url.searchParams, "token");
        const path = validateObjectPath(params["*"]);
        const grant = project.objectStorage.verifyReadGrant(token);
        expiresAt = grant.claims.expiresAt;
        const target = {
          tenant,
          bucketName: params.bucket,
          path,
          action: "object:read",
        } as const;
        const metadata = await project.objectStorage.redeemReadGrantMetadata(grant, target);
        const remainingSeconds = Math.max(0, Math.floor((expiresAt - now()) / 1_000));
        const notModified = notModifiedResponse(
          metadata,
          request.headers,
          resolveCorrelationId(request.headers),
          `public, max-age=${remainingSeconds}, immutable`,
        );
        if (notModified !== null) {
          return notModified;
        }
        object = await project.objectStorage.redeemReadGrant(grant, {
          ...target,
        });
      } catch {
        throw new StorageHttpError("forbidden", 403);
      }
      const remainingSeconds = Math.max(0, Math.floor((expiresAt - now()) / 1_000));
      return objectResponse(
        object,
        request.headers,
        resolveCorrelationId(request.headers),
        `public, max-age=${remainingSeconds}, immutable`,
      );
    }),
  );

  routes.post("/storage/v1/resumable/:bucket/*", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireTusVersion(request.headers);
      const uploadLength = requireNonNegativeIntegerHeader(request.headers, "upload-length");
      if (uploadLength > limits.maxObjectBytes) {
        throw new StorageHttpError("quota", 413);
      }
      const idempotencyKey = requireIdempotencyKey(request.headers);
      const contentType = parseUploadMetadata(request.headers);
      if (contentType !== "application/octet-stream") {
        throw new StorageHttpError("validation", 400);
      }
      await project.objectStorage.reconcileExpiredResumableUploadLeases();
      project.objectStorage.cleanupExpiredResumableUploads();
      const upload = await project.objectStorage.createResumableUpload(context, {
        bucketName: params.bucket,
        path: validateObjectPath(params["*"]),
        uploadLength,
        contentType,
        idempotencyKey,
        expiresAt: checkedTimestamp(now(), limits.resumableUploadTtlMs),
      });
      return new Response(null, {
        status: 201,
        headers: resumableHeaders(upload, context.correlationId, {
          location: new URL(
            `/storage/v1/resumable/${encodeURIComponent(upload.id)}`,
            publicOrigin,
          ).toString(),
        }),
      });
    }),
  );

  routes.head("/storage/v1/resumable/:uploadId", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireTusVersion(request.headers);
      const upload = await project.objectStorage.getResumableUpload(context, params.uploadId);
      return new Response(null, {
        status: 200,
        headers: resumableHeaders(upload, context.correlationId),
      });
    }),
  );

  routes.patch("/storage/v1/resumable/:uploadId", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireTusVersion(request.headers);
      if (
        request.headers.get("content-type")?.trim().toLowerCase() !==
        "application/offset+octet-stream"
      ) {
        throw new StorageHttpError("validation", 400);
      }
      const offset = requireNonNegativeIntegerHeader(request.headers, "upload-offset");
      const chunk = await readBoundedBody(request, limits.maxStorageChunkBytes);
      const result = await project.objectStorage.appendResumableUpload(
        context,
        params.uploadId,
        offset,
        chunk,
      );
      const headers = resumableHeaders(result.upload, context.correlationId);
      if (result.object !== null) {
        setObjectIdentityHeaders(headers, result.object);
        await recordAudit(
          dependencies,
          context,
          "storage.object.create",
          result.object.bucketName,
          result.object.path,
        );
      }
      return new Response(null, { status: 204, headers });
    }),
  );

  routes.delete("/storage/v1/resumable/:uploadId", ({ request, params }) =>
    handleStorageRequest(request, dependencies, now, async (context, project) => {
      requireTusVersion(request.headers);
      let upload: Awaited<ReturnType<RestProject["objectStorage"]["getResumableUpload"]>> | null =
        null;
      try {
        upload = await project.objectStorage.getResumableUpload(context, params.uploadId);
        await project.objectStorage.abortResumableUpload(context, params.uploadId);
      } catch (error) {
        if (!(error instanceof StorageCoreError) || error.code !== "STORAGE_CORE_NOT_FOUND") {
          throw error;
        }
      }
      if (upload !== null) {
        await recordAudit(
          dependencies,
          context,
          "storage.upload.abort",
          upload.bucketName,
          upload.path,
        );
      }
      return new Response(null, {
        status: 204,
        headers: { "tus-resumable": tusVersion, "x-correlation-id": context.correlationId },
      });
    }),
  );

  return routes;
}

async function handleStorageRequest(
  request: Request,
  dependencies: GatewayDependencies,
  now: () => number,
  operation: (context: TenantContext, project: RestProject) => Promise<Response>,
): Promise<Response> {
  const startedAt = now();
  try {
    const context = await dependencies.authenticate(request);
    const headerTenant = parseTenantIdentityFromHeaders(request.headers);
    if (!sameTenant(headerTenant, context.tenant)) {
      throw new StorageHttpError("forbidden", 403);
    }
    if (!(await dependencies.consumeRateLimit(context))) {
      throw new StorageHttpError("quota", 429);
    }
    const project = await dependencies.resolveProject(context);
    if (!sameTenant(project.tenant, context.tenant)) {
      throw new StorageHttpError("forbidden", 403);
    }
    const response = await operation(context, project);
    recordStorageMetric(dependencies, "success", response.status, now() - startedAt);
    return response;
  } catch (error) {
    const response = storageErrorResponse(error, request.headers);
    recordStorageMetric(
      dependencies,
      metricOutcome(response.status),
      response.status,
      now() - startedAt,
    );
    return response;
  }
}

async function handleSignedRequest(
  request: Request,
  dependencies: GatewayDependencies,
  now: () => number,
  operation: (tenant: TenantIdentity, project: RestProject) => Promise<Response>,
): Promise<Response> {
  const startedAt = now();
  try {
    if (!(await dependencies.consumeSignedRateLimit(request))) {
      throw new StorageHttpError("quota", 429);
    }
    let tenant: TenantIdentity;
    try {
      const query = new URL(request.url).searchParams;
      tenant = parseTenantIdentity({
        organizationId: requireSingleQueryParameter(query, "organizationId"),
        projectId: requireSingleQueryParameter(query, "projectId"),
        environmentId: requireSingleQueryParameter(query, "environmentId"),
        branchId: requireSingleQueryParameter(query, "branchId"),
        generation: parseQueryGeneration(requireSingleQueryParameter(query, "generation")),
      });
    } catch {
      throw new StorageHttpError("forbidden", 403);
    }
    let project: RestProject;
    try {
      project = await dependencies.resolveProjectByTenant(tenant);
    } catch {
      throw new StorageHttpError("forbidden", 403);
    }
    if (!sameTenant(project.tenant, tenant)) {
      throw new StorageHttpError("forbidden", 403);
    }
    const response = await operation(tenant, project);
    recordStorageMetric(dependencies, "success", response.status, now() - startedAt);
    return response;
  } catch (error) {
    const response = storageErrorResponse(error, request.headers);
    recordStorageMetric(
      dependencies,
      metricOutcome(response.status),
      response.status,
      now() - startedAt,
    );
    return response;
  }
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  let declaredLength: number | null = null;
  if (contentLength !== null) {
    const parsed = parseNonNegativeInteger(contentLength);
    if (parsed === null) {
      throw new StorageHttpError("validation", 400);
    }
    if (parsed > maxBytes) {
      throw new StorageHttpError("quota", 413);
    }
    declaredLength = parsed;
  }
  if (request.body === null) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new StorageHttpError("quota", 413);
      }
      chunks.push(Uint8Array.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (declaredLength !== null && declaredLength !== body.byteLength) {
    throw new StorageHttpError("validation", 400);
  }
  return body;
}

function parseObjectContentType(headers: Headers): string {
  const value = headers.get("content-type")?.trim().toLowerCase();
  if (value === "text/plain" || /^text\/plain\s*;\s*charset=utf-8$/.test(value ?? "")) {
    return value ?? "text/plain";
  }
  if (
    value === "application/octet-stream" ||
    value === "application/json" ||
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "application/pdf"
  ) {
    return value;
  }
  throw new StorageHttpError("validation", 400);
}

function verifyMime(contentType: string, body: Uint8Array): void {
  const normalized = contentType.split(";", 1)[0] ?? contentType;
  if (normalized === "application/octet-stream") {
    return;
  }
  const magicType = detectMagicType(body);
  if (magicType !== null && magicType !== normalized) {
    throw new StorageHttpError("validation", 400);
  }
  if (normalized === "text/plain") {
    decodeUtf8(body, true);
    return;
  }
  if (normalized === "application/json") {
    try {
      JSON.parse(decodeUtf8(body, false));
      return;
    } catch {
      throw new StorageHttpError("validation", 400);
    }
  }
  if (magicType !== normalized) {
    throw new StorageHttpError("validation", 400);
  }
}

function detectMagicType(body: Uint8Array): string | null {
  if (startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(body, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(body, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "application/pdf";
  }
  return null;
}

function startsWith(body: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => body[index] === value);
}

function decodeUtf8(body: Uint8Array, rejectNul: boolean): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (rejectNul && value.includes("\0")) {
      throw new Error();
    }
    return value;
  } catch {
    throw new StorageHttpError("validation", 400);
  }
}

function verifyClientChecksum(headers: Headers, body: Uint8Array): void {
  const supplied = headers.get("x-mekka-content-sha256");
  if (supplied === null) {
    return;
  }
  if (!checksumPattern.test(supplied)) {
    throw new StorageHttpError("validation", 400);
  }
  const expected = createHash("sha256").update(body).digest();
  const actual = Buffer.from(supplied, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new StorageHttpError("validation", 400);
  }
}

function objectResponse(
  object: StorageObject,
  requestHeaders: Headers,
  correlationId: TenantContext["correlationId"],
  cacheControl: string,
): Response {
  const headers = objectHeaders(object.metadata, correlationId, cacheControl);
  if (etagMatches(requestHeaders.get("if-none-match"), headers.get("etag"))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

function notModifiedResponse(
  metadata: StorageObjectMetadata,
  requestHeaders: Headers,
  correlationId: TenantContext["correlationId"],
  cacheControl: string,
): Response | null {
  const headers = objectHeaders(metadata, correlationId, cacheControl);
  return etagMatches(requestHeaders.get("if-none-match"), headers.get("etag"))
    ? new Response(null, { status: 304, headers })
    : null;
}

function metadataResponse(
  metadata: StorageObjectMetadata,
  correlationId: TenantContext["correlationId"],
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-correlation-id": correlationId,
  });
  setObjectIdentityHeaders(headers, metadata);
  return Response.json(publicObjectMetadata(metadata), { status: 201, headers });
}

function publicObjectMetadata(metadata: StorageObjectMetadata) {
  return Object.freeze({
    bucketName: metadata.bucketName,
    path: metadata.path,
    size: metadata.size,
    contentType: metadata.contentType,
    checksumSha256: metadata.checksumSha256,
    version: metadata.version,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  });
}

function objectHeaders(
  metadata: StorageObjectMetadata,
  correlationId: TenantContext["correlationId"],
  cacheControl: string,
): Headers {
  const headers = new Headers({
    "cache-control": cacheControl === "private" ? "private, must-revalidate" : cacheControl,
    "content-disposition": contentDisposition(metadata.path),
    "content-length": String(metadata.size),
    "content-type": metadata.contentType,
    "x-content-type-options": "nosniff",
    "x-correlation-id": correlationId,
  });
  setObjectIdentityHeaders(headers, metadata);
  return headers;
}

function setObjectIdentityHeaders(headers: Headers, metadata: StorageObjectMetadata): void {
  headers.set("etag", `"${metadata.checksumSha256}"`);
  headers.set("x-mekka-content-sha256", metadata.checksumSha256);
}

function etagMatches(value: string | null, etag: string | null): boolean {
  if (value === null || etag === null) {
    return false;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry === etag || entry === `W/${etag}`);
}

function contentDisposition(path: string): string {
  const filename = path.split("/").at(-1) ?? "download";
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

function jsonResponse(
  body: unknown,
  correlationId: TenantContext["correlationId"],
  status = 200,
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
  });
}

function emptyResponse(correlationId: TenantContext["correlationId"]): Response {
  return new Response(null, { status: 204, headers: { "x-correlation-id": correlationId } });
}

function parseBucketMutation(
  body: Uint8Array,
  requiresName: true,
): Readonly<{ name: string; isPublic: boolean }>;
function parseBucketMutation(
  body: Uint8Array,
  requiresName: false,
): Readonly<{ isPublic: boolean }>;
function parseBucketMutation(
  body: Uint8Array,
  requiresName: boolean,
): Readonly<{ name: string; isPublic: boolean }> | Readonly<{ isPublic: boolean }> {
  const parsed = parseJsonRecord(body);
  const allowedKeys = requiresName ? ["name", "isPublic"] : ["isPublic"];
  if (Object.keys(parsed).some((key) => !allowedKeys.includes(key))) {
    throw new StorageHttpError("validation", 400);
  }
  if (typeof parsed.isPublic !== "boolean") throw new StorageHttpError("validation", 400);
  if (!requiresName) return Object.freeze({ isPublic: parsed.isPublic });
  if (typeof parsed.name !== "string") throw new StorageHttpError("validation", 400);
  return Object.freeze({ name: parsed.name, isPublic: parsed.isPublic });
}

function parseJsonRecord(body: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeUtf8(body, false));
  } catch {
    throw new StorageHttpError("validation", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageHttpError("validation", 400);
  }
  return parsed as Record<string, unknown>;
}

function requireStorageAdmin(context: TenantContext, currentTime: number): void {
  if (!hasCapability(context, "storage:admin", currentTime)) {
    throw new StorageHttpError("forbidden", 403);
  }
}

async function recordAudit(
  dependencies: GatewayDependencies,
  context: TenantContext,
  action: Parameters<GatewayDependencies["recordStorageAudit"]>[0]["action"],
  bucketName: string,
  objectPath?: string,
): Promise<void> {
  try {
    await dependencies.recordStorageAudit({
      action,
      tenant: context.tenant,
      actor: context.actor,
      correlationId: context.correlationId,
      bucketName,
      ...(objectPath === undefined
        ? {}
        : { objectPathHash: createHash("sha256").update(objectPath).digest("hex") }),
    });
  } catch {
    // Audit transport failures must not alter an already completed storage operation.
  }
}

function parseSignInput(body: Uint8Array): Readonly<{ expiresIn: number }> {
  const parsed = parseJsonRecord(body);
  if (
    Object.keys(parsed).length !== 1 ||
    !("expiresIn" in parsed) ||
    !Number.isSafeInteger(parsed.expiresIn) ||
    (parsed.expiresIn as number) < 1
  ) {
    throw new StorageHttpError("validation", 400);
  }
  return Object.freeze({ expiresIn: parsed.expiresIn as number });
}

function parseUploadMetadata(headers: Headers): string {
  const value = headers.get("upload-metadata");
  if (value === null || value.includes(",")) {
    throw new StorageHttpError("validation", 400);
  }
  const match = /^contentType ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match?.[1] === undefined) {
    throw new StorageHttpError("validation", 400);
  }
  const encoded = match[1];
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new StorageHttpError("validation", 400);
  }
  return decodeUtf8(decoded, true);
}

function resumableHeaders(
  upload: Readonly<{
    offset: number;
    uploadLength: number;
    expiresAt: number;
  }>,
  correlationId: TenantContext["correlationId"],
  extra: Readonly<{ location?: string }> = {},
): Headers {
  return new Headers({
    "tus-resumable": tusVersion,
    "upload-offset": String(upload.offset),
    "upload-length": String(upload.uploadLength),
    "upload-expires": new Date(upload.expiresAt).toUTCString(),
    "x-correlation-id": correlationId,
    ...(extra.location === undefined ? {} : { location: extra.location }),
  });
}

function requireTusVersion(headers: Headers): void {
  if (headers.get("tus-resumable") !== tusVersion) {
    throw new StorageHttpError("validation", 400);
  }
}

function requireJsonContentType(headers: Headers): void {
  if (headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new StorageHttpError("validation", 400);
  }
}

function requireIdempotencyKey(headers: Headers): string {
  const value = headers.get("idempotency-key");
  if (value === null || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new StorageHttpError("validation", 400);
  }
  return value;
}

function requireNonNegativeIntegerHeader(headers: Headers, name: string): number {
  const value = headers.get(name);
  const parsed = value === null ? null : parseNonNegativeInteger(value);
  if (parsed === null) {
    throw new StorageHttpError("validation", 400);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validateObjectPath(value: string): string {
  let decoded = value;
  let normalized = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw new StorageHttpError("validation", 400);
    }
    if (next === decoded) {
      break;
    }
    if (attempt === 0) {
      normalized = next;
    }
    if (
      next.includes("\\") ||
      next.includes("\0") ||
      next.startsWith("/") ||
      next.endsWith("/") ||
      next.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
    ) {
      throw new StorageHttpError("validation", 400);
    }
    decoded = next;
  }
  if (
    normalized.length < 1 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
  ) {
    throw new StorageHttpError("validation", 400);
  }
  return normalized;
}

function requireSingleQueryParameter(query: URLSearchParams, name: string): string {
  const values = query.getAll(name);
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0) {
    throw new StorageHttpError("validation", 400);
  }
  return values[0];
}

function parseQueryGeneration(value: string): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed === null || parsed < 1) {
    throw new StorageHttpError("validation", 400);
  }
  return parsed;
}

function setTenantQuery(url: URL, tenant: TenantIdentity): void {
  url.searchParams.set("organizationId", tenant.organizationId);
  url.searchParams.set("projectId", tenant.projectId);
  url.searchParams.set("environmentId", tenant.environmentId);
  url.searchParams.set("branchId", tenant.branchId);
  url.searchParams.set("generation", String(tenant.generation));
}

function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function checkedTimestamp(now: number, delta: number): number {
  const result = now + delta;
  if (!Number.isSafeInteger(now) || now < 1 || !Number.isSafeInteger(result)) {
    throw new StorageHttpError("infrastructure", 503);
  }
  return result;
}

function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("storagePublicOrigin must be an absolute HTTP(S) origin.");
  }
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      )) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("storagePublicOrigin must be an absolute HTTP(S) origin.");
  }
  return url.origin;
}

function storageErrorResponse(error: unknown, headers: Headers): Response {
  const mapped = mapStorageError(error);
  const correlationId = resolveCorrelationId(headers);
  return Response.json(createErrorEnvelope(mapped.code, correlationId), {
    status: mapped.status,
    headers: { "cache-control": "no-store", "x-correlation-id": correlationId },
  });
}

function mapStorageError(error: unknown): StorageHttpError {
  if (error instanceof StorageHttpError) {
    return error;
  }
  if (error instanceof ProtocolError) {
    return new StorageHttpError(error.code, protocolStatus(error.code));
  }
  if (error instanceof StorageCoreError) {
    switch (error.code) {
      case "STORAGE_CORE_VALIDATION":
        return new StorageHttpError("validation", 400);
      case "STORAGE_CORE_FORBIDDEN":
        return new StorageHttpError("forbidden", 403);
      case "STORAGE_CORE_NOT_FOUND":
        return new StorageHttpError("validation", 404);
      case "STORAGE_CORE_CONFLICT":
        return new StorageHttpError("conflict", 409);
      case "STORAGE_CORE_QUOTA":
        return new StorageHttpError("quota", 429);
      case "STORAGE_CORE_UNSUPPORTED":
        return new StorageHttpError("unsupported", 501);
      case "STORAGE_CORE_INFRASTRUCTURE":
        return new StorageHttpError("infrastructure", 503);
    }
  }
  return new StorageHttpError("infrastructure", 503);
}

function protocolStatus(code: StorageHttpError["code"]): number {
  switch (code) {
    case "auth":
      return 401;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "quota":
      return 429;
    case "unsupported":
      return 501;
    case "infrastructure":
      return 503;
    case "validation":
      return 400;
  }
}

function metricOutcome(status: number): GatewayMetric["outcome"] {
  if (status === 429) {
    return "rate_limited";
  }
  return status >= 500 ? "infrastructure_error" : "client_error";
}

function recordStorageMetric(
  dependencies: GatewayDependencies,
  outcome: GatewayMetric["outcome"],
  status: number,
  durationMs: number,
): void {
  try {
    void Promise.resolve(
      dependencies.recordMetric({ outcome, status, durationMs, rowCount: 0 }),
    ).catch(() => undefined);
  } catch {
    // Telemetry failures must not alter the client response.
  }
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

class StorageHttpError extends Error {
  constructor(
    readonly code:
      | "validation"
      | "auth"
      | "forbidden"
      | "conflict"
      | "quota"
      | "unsupported"
      | "infrastructure",
    readonly status: number,
  ) {
    super("Storage request failed.");
    this.name = "StorageHttpError";
  }
}
