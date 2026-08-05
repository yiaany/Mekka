import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { type FileHandle, link, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ObjectProvider,
  ObjectProviderError,
  type ObjectProviderMetadata,
  type ObjectProviderPutRequest,
} from "./object-provider";

export function createLocalObjectProvider(rootDirectory: string): ObjectProvider {
  if (typeof rootDirectory !== "string" || rootDirectory.length === 0) {
    throw invalidProvider("Local object provider requires a root directory.");
  }
  const root = resolve(rootDirectory);

  const provider: ObjectProvider = {
    async put(request) {
      const stableRequest = Object.freeze({ ...request, body: Uint8Array.from(request.body) });
      validatePutRequest(stableRequest);
      const destination = securePath(root, stableRequest.key);
      const existing = await headLocalObject(root, stableRequest.key);
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

      await mkdir(dirname(destination), { recursive: true });
      const pendingDirectory = resolve(root, ".pending");
      await mkdir(pendingDirectory, { recursive: true });
      const temporary = resolve(pendingDirectory, randomUUID());
      try {
        await writeFile(temporary, stableRequest.body, { flag: "wx" });
        await link(temporary, destination);
      } catch (error) {
        const concurrent = await headLocalObject(root, stableRequest.key);
        if (concurrent !== null && sameContent(concurrent, stableRequest)) {
          return concurrent;
        }
        throw mapFilesystemError(error);
      } finally {
        await rm(temporary, { force: true });
      }

      const stored = await headLocalObject(root, stableRequest.key);
      if (stored === null) {
        throw unavailableProvider();
      }
      return stored;
    },

    head(key) {
      return headLocalObject(root, key);
    },

    async get(key, maxBytes) {
      const normalizedKey = validateKey(key, false);
      const limit = validateReadLimit(maxBytes);
      const path = securePath(root, normalizedKey);
      let handle: FileHandle | undefined;
      try {
        handle = await open(path, "r");
        const details = await handle.stat();
        if (!details.isFile()) {
          return null;
        }
        if (details.size > limit) {
          throw invalidProvider("Object exceeds the permitted read size.");
        }
        const body = new Uint8Array(details.size);
        let offset = 0;
        while (offset < body.byteLength) {
          const result = await handle.read(body, offset, body.byteLength - offset, offset);
          if (result.bytesRead === 0) {
            throw unavailableProvider();
          }
          offset += result.bytesRead;
        }
        const actualChecksum = createHash("sha256").update(body).digest("hex");
        return Object.freeze({
          metadata: Object.freeze({
            key: normalizedKey,
            size: body.byteLength,
            checksumSha256: actualChecksum,
            etag: actualChecksum,
          }),
          body: Uint8Array.from(body),
        });
      } catch (error) {
        if (isFilesystemCode(error, "ENOENT")) {
          return null;
        }
        throw mapFilesystemError(error);
      } finally {
        await handle?.close();
      }
    },

    async delete(key) {
      try {
        await rm(securePath(root, key), { force: true });
      } catch (error) {
        throw mapFilesystemError(error);
      }
    },

    async list(prefix) {
      const normalizedPrefix = prefix === "" ? "" : validateKey(prefix, true);
      const files = await listFiles(root);
      const matching = files
        .flatMap((file) => {
          const key = decodeKey(root, file);
          return key === null ? [] : [key];
        })
        .filter((key) => key.startsWith(normalizedPrefix))
        .sort();
      return Object.freeze(
        await Promise.all(
          matching.map(async (key) => {
            const metadata = await headLocalObject(root, key);
            if (metadata === null) {
              throw unavailableProvider();
            }
            return metadata;
          }),
        ),
      );
    },

    close() {},
  };
  return Object.freeze(provider);
}

async function headLocalObject(root: string, key: string): Promise<ObjectProviderMetadata | null> {
  const normalizedKey = validateKey(key, false);
  const path = securePath(root, normalizedKey);
  try {
    const details = await stat(path);
    if (!details.isFile()) {
      return null;
    }
    const checksumSha256 = await hashFile(path);
    return Object.freeze({
      key: normalizedKey,
      size: details.size,
      checksumSha256,
      etag: checksumSha256,
    });
  } catch (error) {
    if (isFilesystemCode(error, "ENOENT")) {
      return null;
    }
    throw mapFilesystemError(error);
  }
}

function securePath(root: string, key: string): string {
  const normalizedKey = validateKey(key, false);
  const segments = normalizedKey.split("/").map(encodeSegment);
  if (segments.some((segment) => segment.length > 240)) {
    throw invalidProvider("Object key contains a segment that is too long for local storage.");
  }
  const path = resolve(root, ...segments);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw invalidProvider("Object key resolves outside the provider root.");
  }
  return path;
}

function validateKey(value: string, allowTrailingSlash: boolean): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    isAbsolute(value) ||
    hasUnpairedSurrogate(value)
  ) {
    throw invalidProvider("Object provider key is invalid.");
  }
  const segments = value.split("/");
  const last = segments.at(-1);
  if (
    segments.some((segment, index) => {
      if (allowTrailingSlash && index === segments.length - 1 && segment === "") {
        return false;
      }
      return segment === "" || segment === "." || segment === "..";
    }) ||
    (!allowTrailingSlash && last === "")
  ) {
    throw invalidProvider("Object provider key contains a forbidden path segment.");
  }
  return value;
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
      }),
    );
    return nested.flat();
  } catch (error) {
    if (isFilesystemCode(error, "ENOENT")) {
      return [];
    }
    throw mapFilesystemError(error);
  }
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeKey(root: string, file: string): string | null {
  const segments = relative(root, file).split(sep);
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) {
    return null;
  }
  const decoded = segments.map((segment) => Buffer.from(segment, "base64url").toString("utf8"));
  if (decoded.some((segment, index) => encodeSegment(segment) !== segments[index])) {
    return null;
  }
  return decoded.join("/");
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

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    let digest: string | null = null;
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      digest = hash.digest("hex");
    });
    stream.on("close", () => {
      if (digest !== null) {
        resolveHash(digest);
      }
    });
  });
}

function validatePutRequest(request: ObjectProviderPutRequest): void {
  validateKey(request.key, false);
  if (!(request.body instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(request.checksumSha256)) {
    throw invalidProvider("Object provider put request is invalid.");
  }
  const actualChecksum = createHash("sha256").update(request.body).digest("hex");
  if (actualChecksum !== request.checksumSha256) {
    throw invalidProvider("Object body checksum does not match the request.");
  }
}

function validateReadLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidProvider("Object provider read limit is invalid.");
  }
  return value;
}

function sameContent(metadata: ObjectProviderMetadata, request: ObjectProviderPutRequest): boolean {
  return (
    metadata.size === request.body.byteLength && metadata.checksumSha256 === request.checksumSha256
  );
}

function mapFilesystemError(error: unknown): ObjectProviderError {
  if (error instanceof ObjectProviderError) {
    return error;
  }
  return unavailableProvider();
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function invalidProvider(message: string): ObjectProviderError {
  return new ObjectProviderError("OBJECT_PROVIDER_INVALID", message, false);
}

function unavailableProvider(): ObjectProviderError {
  return new ObjectProviderError(
    "OBJECT_PROVIDER_UNAVAILABLE",
    "Local object provider operation failed.",
    true,
  );
}
