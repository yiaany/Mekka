import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import {
  type ObjectProvider,
  ObjectProviderError,
  type ObjectProviderMetadata,
  type ObjectProviderPutRequest,
} from "./object-provider";

export type S3ObjectProviderOptions = Readonly<{
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}>;

const s3ObjectKeyMaxUtf8Bytes = 1_024;

export function createS3ObjectProvider(options: S3ObjectProviderOptions): ObjectProvider {
  if (typeof options.bucket !== "string" || options.bucket.length === 0) {
    throw new ObjectProviderError(
      "OBJECT_PROVIDER_INVALID",
      "S3 object provider requires a bucket name.",
      false,
    );
  }
  if (options.client !== undefined && options.clientConfig !== undefined) {
    throw new ObjectProviderError(
      "OBJECT_PROVIDER_INVALID",
      "Provide either an S3 client or client configuration, not both.",
      false,
    );
  }
  const client = options.client ?? new S3Client(options.clientConfig ?? {});
  const ownsClient = options.client === undefined;

  const provider: ObjectProvider = {
    async put(request) {
      const stableRequest = Object.freeze({ ...request, body: Uint8Array.from(request.body) });
      validatePutRequest(stableRequest);
      try {
        const existing = await headS3Object(client, options.bucket, stableRequest.key);
        if (existing !== null) {
          if (sameContent(existing, stableRequest)) {
            return existing;
          }
          throw new ObjectProviderError(
            "OBJECT_PROVIDER_CONFLICT",
            "Object provider key already contains different content.",
            false,
          );
        }

        const result = await client.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: stableRequest.key,
            Body: stableRequest.body,
            ContentLength: stableRequest.body.byteLength,
            ContentType: stableRequest.contentType,
            IfNoneMatch: "*",
            Metadata: {
              "mekka-sha256": stableRequest.checksumSha256,
              "mekka-idempotency-key": stableRequest.idempotencyKey,
            },
          }),
        );
        const stored = await headS3Object(client, options.bucket, stableRequest.key);
        if (stored === null || !sameContent(stored, stableRequest)) {
          throw new ObjectProviderError(
            "OBJECT_PROVIDER_UNAVAILABLE",
            "S3 object could not be verified after upload.",
            true,
          );
        }
        return Object.freeze({ ...stored, etag: stored.etag ?? result.ETag ?? null });
      } catch (error) {
        if (isS3PreconditionFailed(error)) {
          const concurrent = await headS3Object(client, options.bucket, stableRequest.key);
          if (concurrent !== null && sameContent(concurrent, stableRequest)) {
            return concurrent;
          }
          throw new ObjectProviderError(
            "OBJECT_PROVIDER_CONFLICT",
            "Object provider key already contains different content.",
            false,
          );
        }
        throw mapS3Error(error);
      }
    },

    async head(key) {
      validateS3Key(key, false);
      return headS3Object(client, options.bucket, key);
    },

    async get(key, maxBytes) {
      validateS3Key(key, false);
      const limit = validateReadLimit(maxBytes);
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
        );
        const checksumSha256 = result.Metadata?.["mekka-sha256"];
        if (
          checksumSha256 === undefined ||
          !/^[a-f0-9]{64}$/.test(checksumSha256) ||
          result.Body === undefined
        ) {
          throw invalidS3Provider("S3 object is missing required data.");
        }
        if (result.ContentLength !== undefined && result.ContentLength > limit) {
          throw invalidS3Provider("Object exceeds the permitted read size.");
        }
        const body = await readBoundedBody(result.Body, limit);
        const actualChecksum = createHash("sha256").update(body).digest("hex");
        if (actualChecksum !== checksumSha256) {
          throw invalidS3Provider("S3 object checksum verification failed.");
        }
        const metadata = Object.freeze({
          key,
          size: body.byteLength,
          checksumSha256,
          etag: result.ETag ?? null,
        });
        return Object.freeze({ metadata, body: Uint8Array.from(body) });
      } catch (error) {
        if (isS3NotFound(error)) {
          return null;
        }
        throw mapS3Error(error);
      }
    },

    async delete(key) {
      validateS3Key(key, false);
      try {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
      } catch (error) {
        throw mapS3Error(error);
      }
    },

    async list(prefix) {
      validateS3Key(prefix, true);
      const objects: ObjectProviderMetadata[] = [];
      let continuationToken: string | undefined;
      try {
        do {
          const result = await client.send(
            new ListObjectsV2Command({
              Bucket: options.bucket,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            }),
          );
          for (const object of result.Contents ?? []) {
            if (object.Key === undefined) {
              continue;
            }
            validateS3Key(object.Key, false);
            const metadata = await headS3Object(client, options.bucket, object.Key);
            if (metadata !== null) {
              objects.push(metadata);
            }
          }
          continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
        } while (continuationToken !== undefined);
      } catch (error) {
        throw mapS3Error(error);
      }
      return Object.freeze(objects.sort((left, right) => left.key.localeCompare(right.key)));
    },

    close() {
      if (ownsClient) {
        client.destroy();
      }
    },
  };
  return Object.freeze(provider);
}

async function headS3Object(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<ObjectProviderMetadata | null> {
  validateS3Key(key, false);
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const checksumSha256 = result.Metadata?.["mekka-sha256"];
    if (checksumSha256 === undefined || !/^[a-f0-9]{64}$/.test(checksumSha256)) {
      throw new ObjectProviderError(
        "OBJECT_PROVIDER_INVALID",
        "S3 object is missing the required Mekka checksum metadata.",
        false,
      );
    }
    return Object.freeze({
      key,
      size: result.ContentLength ?? 0,
      checksumSha256,
      etag: result.ETag ?? null,
    });
  } catch (error) {
    if (isS3NotFound(error)) {
      return null;
    }
    throw mapS3Error(error);
  }
}

function validatePutRequest(request: ObjectProviderPutRequest): void {
  validateS3Key(request.key, false);
  const actualChecksum =
    request.body instanceof Uint8Array
      ? createHash("sha256").update(request.body).digest("hex")
      : null;
  if (
    typeof request.key !== "string" ||
    request.key.length === 0 ||
    !(request.body instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/.test(request.checksumSha256) ||
    actualChecksum !== request.checksumSha256
  ) {
    throw new ObjectProviderError(
      "OBJECT_PROVIDER_INVALID",
      "S3 object provider put request is invalid.",
      false,
    );
  }
}

function validateS3Key(value: string, allowEmpty: boolean): void {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > s3ObjectKeyMaxUtf8Bytes
  ) {
    throw invalidS3Provider("S3 object provider key is invalid.");
  }
}

function validateReadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidS3Provider("S3 object provider read limit is invalid.");
  }
  return value;
}

async function readBoundedBody(body: unknown, maxBytes: number): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) {
      throw invalidS3Provider("Object exceeds the permitted read size.");
    }
    return Uint8Array.from(body);
  }
  if (!isAsyncIterable(body)) {
    throw invalidS3Provider("S3 object body is not readable.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = toBytes(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw invalidS3Provider("Object exceeds the permitted read size.");
    }
    chunks.push(bytes);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  throw invalidS3Provider("S3 object body contained an invalid chunk.");
}

function sameContent(metadata: ObjectProviderMetadata, request: ObjectProviderPutRequest): boolean {
  return (
    metadata.size === request.body.byteLength && metadata.checksumSha256 === request.checksumSha256
  );
}

function isS3NotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && (error.name === "NotFound" || error.name === "NoSuchKey")) ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

function isS3PreconditionFailed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && error.name === "PreconditionFailed") ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 412))
  );
}

function mapS3Error(error: unknown): ObjectProviderError {
  if (error instanceof ObjectProviderError) {
    return error;
  }
  const output = error as Partial<ServiceOutputTypes> & {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = output.$metadata?.httpStatusCode;
  if (status === 429 || output.name === "SlowDown" || output.name === "Throttling") {
    return new ObjectProviderError(
      "OBJECT_PROVIDER_THROTTLED",
      "S3 object provider throttled the operation.",
      true,
    );
  }
  return new ObjectProviderError(
    "OBJECT_PROVIDER_UNAVAILABLE",
    "S3 object provider operation failed.",
    status === undefined || status >= 500,
  );
}

function invalidS3Provider(message: string): ObjectProviderError {
  return new ObjectProviderError("OBJECT_PROVIDER_INVALID", message, false);
}
