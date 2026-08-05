import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantIdentity } from "@mekka/protocol";

const verifiedGrantBrand: unique symbol = Symbol("verifiedStorageReadGrant");

export type SignedReadGrantClaims = Readonly<{
  version: 1;
  keyId: string;
  tenant: TenantIdentity;
  bucketName: string;
  objectPath: string;
  objectVersion: string;
  action: "object:read";
  expiresAt: number;
}>;

export type VerifiedReadGrant = Readonly<{
  claims: SignedReadGrantClaims;
  [verifiedGrantBrand]: true;
}>;

export type SignedReadGrantKey = Readonly<{
  id: string;
  secret: Uint8Array;
}>;

export type SignedReadGrantAuthorityOptions = Readonly<{
  current: SignedReadGrantKey;
  previous?: SignedReadGrantKey;
  now?: () => number;
}>;

export interface SignedReadGrantAuthority {
  issue(claims: Omit<SignedReadGrantClaims, "version" | "keyId" | "action">): string;
  verify(token: string): VerifiedReadGrant;
  accepts(grant: VerifiedReadGrant): boolean;
}

type SerializedClaims = Readonly<{
  v: 1;
  kid: string;
  org: string;
  project: string;
  environment: string;
  branch: string;
  generation: number;
  bucket: string;
  path: string;
  objectVersion: string;
  action: "object:read";
  exp: number;
}>;

export function createSignedReadGrantAuthority(
  options: SignedReadGrantAuthorityOptions,
): SignedReadGrantAuthority {
  const current = normalizeKey(options.current);
  const previous = options.previous === undefined ? undefined : normalizeKey(options.previous);
  if (previous?.id === current.id) {
    throw new Error("Signed grant configuration is invalid.");
  }
  const keys = new Map<string, Uint8Array>([[current.id, current.secret]]);
  if (previous !== undefined) {
    keys.set(previous.id, previous.secret);
  }
  const now = options.now ?? Date.now;
  const issued = new WeakSet<object>();

  return Object.freeze({
    issue(claims: Omit<SignedReadGrantClaims, "version" | "keyId" | "action">) {
      const serialized = serializeClaims(claims, current.id);
      const payload = Buffer.from(JSON.stringify(serialized), "utf8").toString("base64url");
      const signature = sign(payload, current.secret);
      return `${payload}.${signature.toString("base64url")}`;
    },
    verify(token: string) {
      try {
        const [payload, signatureText, extra] = token.split(".");
        if (
          payload === undefined ||
          signatureText === undefined ||
          extra !== undefined ||
          !isCanonicalBase64Url(payload) ||
          !isCanonicalBase64Url(signatureText)
        ) {
          throw new Error();
        }
        const serialized = parseSerializedClaims(payload);
        const secret = keys.get(serialized.kid);
        if (secret === undefined) {
          throw new Error();
        }
        const supplied = Buffer.from(signatureText, "base64url");
        const expected = sign(payload, secret);
        if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
          throw new Error();
        }
        if (serialized.exp <= validNow(now())) {
          throw new Error();
        }
        const grant = Object.freeze({
          claims: toClaims(serialized),
          [verifiedGrantBrand]: true as const,
        });
        issued.add(grant);
        return grant;
      } catch {
        throw new Error("Signed grant is invalid.");
      }
    },
    accepts(grant: VerifiedReadGrant) {
      return typeof grant === "object" && grant !== null && issued.has(grant);
    },
  });
}

function normalizeKey(key: SignedReadGrantKey): Readonly<{ id: string; secret: Uint8Array }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id) || !(key.secret instanceof Uint8Array)) {
    throw new Error("Signed grant configuration is invalid.");
  }
  if (key.secret.byteLength < 32) {
    throw new Error("Signed grant secret must contain at least 32 bytes.");
  }
  return Object.freeze({ id: key.id, secret: Uint8Array.from(key.secret) });
}

function serializeClaims(
  claims: Omit<SignedReadGrantClaims, "version" | "keyId" | "action">,
  keyId: string,
): SerializedClaims {
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt < 1) {
    throw new Error("Signed grant claims are invalid.");
  }
  return Object.freeze({
    v: 1,
    kid: keyId,
    org: claims.tenant.organizationId,
    project: claims.tenant.projectId,
    environment: claims.tenant.environmentId,
    branch: claims.tenant.branchId,
    generation: claims.tenant.generation,
    bucket: claims.bucketName,
    path: claims.objectPath,
    objectVersion: claims.objectVersion,
    action: "object:read",
    exp: claims.expiresAt,
  });
}

function parseSerializedClaims(payload: string): SerializedClaims {
  const decoded: unknown = JSON.parse(decodeCanonicalBase64Url(payload).toString("utf8"));
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("v" in decoded) ||
    decoded.v !== 1 ||
    !("kid" in decoded) ||
    typeof decoded.kid !== "string" ||
    !("org" in decoded) ||
    typeof decoded.org !== "string" ||
    !("project" in decoded) ||
    typeof decoded.project !== "string" ||
    !("environment" in decoded) ||
    typeof decoded.environment !== "string" ||
    !("branch" in decoded) ||
    typeof decoded.branch !== "string" ||
    !("generation" in decoded) ||
    !Number.isSafeInteger(decoded.generation) ||
    !("bucket" in decoded) ||
    typeof decoded.bucket !== "string" ||
    !("path" in decoded) ||
    typeof decoded.path !== "string" ||
    !("objectVersion" in decoded) ||
    typeof decoded.objectVersion !== "string" ||
    !("action" in decoded) ||
    decoded.action !== "object:read" ||
    !("exp" in decoded) ||
    !Number.isSafeInteger(decoded.exp)
  ) {
    throw new Error();
  }
  return decoded as SerializedClaims;
}

function isCanonicalBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

function decodeCanonicalBase64Url(value: string): Buffer {
  if (!isCanonicalBase64Url(value)) {
    throw new Error();
  }
  return Buffer.from(value, "base64url");
}

function toClaims(serialized: SerializedClaims): SignedReadGrantClaims {
  return Object.freeze({
    version: 1,
    keyId: serialized.kid,
    tenant: Object.freeze({
      organizationId: serialized.org as TenantIdentity["organizationId"],
      projectId: serialized.project as TenantIdentity["projectId"],
      environmentId: serialized.environment as TenantIdentity["environmentId"],
      branchId: serialized.branch as TenantIdentity["branchId"],
      generation: serialized.generation as TenantIdentity["generation"],
    }),
    bucketName: serialized.bucket,
    objectPath: serialized.path,
    objectVersion: serialized.objectVersion,
    action: "object:read",
    expiresAt: serialized.exp,
  });
}

function sign(payload: string, secret: Uint8Array): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error();
  }
  return value;
}
