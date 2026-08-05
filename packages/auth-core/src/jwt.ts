import {
  SignJWT,
  createLocalJWKSet,
  importPKCS8,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from "jose";
import { parseTenantIdentity, type TenantIdentity } from "@mekka/protocol";

export type AuthSigningKeyStore = Readonly<{
  readSigningKeySet(input: Readonly<{ tenant: TenantIdentity }>): Promise<AuthSigningKeySet>;
}>;

export type AuthSigningKeySet = Readonly<{
  current: Readonly<{ kid: string; privateKeyPkcs8: string; publicKeyJwk: JWK }>;
  previous?: readonly Readonly<{ kid: string; publicKeyJwk: JWK; expiresAt: number }>[];
}>;

export type AuthJwtBinding = Readonly<{
  issuer: string;
  audience: string;
  tenant: TenantIdentity;
}>;

export type VerifiedAuthAccessToken = Readonly<{
  userId: string;
  sessionId: string;
  tenant: TenantIdentity;
  issuedAt: number;
  expiresAt: number;
  tokenId: string;
}>;

export type AuthJwtAuthority = Readonly<{
  issueAccessToken(userId: string, sessionId: string): Promise<IssuedAccessToken>;
  verifyAccessToken(token: string): Promise<VerifiedAuthAccessToken>;
  jwks(): Readonly<{ keys: readonly JWK[] }>;
}>;

export type IssuedAccessToken = Readonly<{
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
}>;

export class AuthJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthJwtError";
  }
}

const algorithm = "ES256" as const;
const accessTokenLifetimeSeconds = 15 * 60;
const clockToleranceSeconds = 30;
const keyIdPattern = /^[A-Za-z0-9_-]{8,128}$/;

export async function openAuthJwtAuthority(
  binding: AuthJwtBinding,
  keyStore: AuthSigningKeyStore,
  now: () => number = Date.now,
): Promise<AuthJwtAuthority> {
  const tenant = parseTenantIdentity(binding.tenant);
  const keySet = await keyStore.readSigningKeySet({ tenant });
  validateKeySet(keySet);

  const privateKey = await importPKCS8(keySet.current.privateKeyPkcs8, algorithm);
  const currentPublicJwk = Object.freeze({
    ...keySet.current.publicKeyJwk,
    alg: algorithm,
    kid: keySet.current.kid,
    use: "sig",
  });
  const previousKeys = Object.freeze(
    (keySet.previous ?? []).map((key) =>
      Object.freeze({
        ...key.publicKeyJwk,
        alg: algorithm,
        kid: key.kid,
        use: "sig",
      }),
    ),
  );
  const keyProbe = await new SignJWT({ probe: true })
    .setProtectedHeader({ alg: algorithm, kid: keySet.current.kid })
    .setExpirationTime(Math.floor(now() / 1000) + 60)
    .sign(privateKey);
  try {
    await jwtVerify(keyProbe, createLocalJWKSet({ keys: [currentPublicJwk] }), {
      algorithms: [algorithm],
      currentDate: new Date(now()),
    });
  } catch {
    throw new AuthJwtError("Current signing key pair does not match.");
  }

  function publishedKeys(): readonly JWK[] {
    const activePreviousKeys = previousKeys.filter((_, index) => {
      const previous = keySet.previous?.[index];
      return previous !== undefined && previous.expiresAt > now();
    });
    return Object.freeze([currentPublicJwk, ...activePreviousKeys]);
  }

  return Object.freeze({
    async issueAccessToken(userId: string, sessionId: string): Promise<IssuedAccessToken> {
      validateSubject(userId, "user");
      validateSubject(sessionId, "session");
      const issuedAt = Math.floor(now() / 1000);
      const expiresAt = issuedAt + accessTokenLifetimeSeconds;
      const accessToken = await new SignJWT({
        role: "authenticated",
        sid: sessionId,
        tenant: serializeTenant(tenant),
      })
        .setProtectedHeader({ alg: algorithm, kid: keySet.current.kid, typ: "JWT" })
        .setIssuer(binding.issuer)
        .setAudience(binding.audience)
        .setSubject(userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .setJti(crypto.randomUUID())
        .sign(privateKey);

      return Object.freeze({
        accessToken,
        expiresIn: accessTokenLifetimeSeconds,
        tokenType: "Bearer",
      });
    },

    async verifyAccessToken(token: string): Promise<VerifiedAuthAccessToken> {
      try {
        const { payload, protectedHeader } = await jwtVerify(
          token,
          createLocalJWKSet({ keys: [...publishedKeys()] }),
          {
            algorithms: [algorithm],
            audience: binding.audience,
            clockTolerance: clockToleranceSeconds,
            currentDate: new Date(now()),
            issuer: binding.issuer,
            typ: "JWT",
          },
        );
        if (
          !protectedHeader.kid ||
          !publishedKeys().some((key) => key.kid === protectedHeader.kid)
        ) {
          throw new AuthJwtError("Access token signing key is not active.");
        }
        return parseVerifiedPayload(payload, tenant);
      } catch (error) {
        if (error instanceof AuthJwtError) {
          throw error;
        }
        throw new AuthJwtError("Access token validation failed.");
      }
    },

    jwks(): Readonly<{ keys: readonly JWK[] }> {
      return Object.freeze({ keys: publishedKeys() });
    },
  });
}

function validateKeySet(keySet: AuthSigningKeySet): void {
  if (
    !keyIdPattern.test(keySet.current.kid) ||
    keySet.current.privateKeyPkcs8.length < 64 ||
    !isPublicSigningJwk(keySet.current.publicKeyJwk)
  ) {
    throw new AuthJwtError("Current signing key is invalid.");
  }

  const keyIds = new Set([keySet.current.kid]);
  for (const key of keySet.previous ?? []) {
    if (
      !keyIdPattern.test(key.kid) ||
      keyIds.has(key.kid) ||
      !Number.isSafeInteger(key.expiresAt) ||
      key.expiresAt < 1 ||
      !isPublicSigningJwk(key.publicKeyJwk)
    ) {
      throw new AuthJwtError("Previous signing key is invalid.");
    }
    keyIds.add(key.kid);
  }
}

function isPublicSigningJwk(jwk: JWK): boolean {
  return (
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    !("d" in jwk)
  );
}

function parseVerifiedPayload(
  payload: JWTPayload,
  expectedTenant: TenantIdentity,
): VerifiedAuthAccessToken {
  if (
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string" ||
    payload.role !== "authenticated" ||
    typeof payload.tenant !== "object" ||
    payload.tenant === null
  ) {
    throw new AuthJwtError("Access token claims are invalid.");
  }

  const tenantClaim = payload.tenant as Record<string, unknown>;
  const tenant = parseTenantIdentity({
    organizationId: tenantClaim.organizationId,
    projectId: tenantClaim.projectId,
    environmentId: tenantClaim.environmentId,
    branchId: tenantClaim.branchId,
    generation: tenantClaim.generation,
  });
  if (!sameTenant(tenant, expectedTenant)) {
    throw new AuthJwtError("Access token tenant does not match the verifier.");
  }

  return Object.freeze({
    userId: payload.sub,
    sessionId: payload.sid,
    tenant,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    tokenId: payload.jti,
  });
}

function validateSubject(value: string, name: string): void {
  if (value.length < 3 || value.length > 256) {
    throw new AuthJwtError(`Access token ${name} subject is invalid.`);
  }
}

function serializeTenant(tenant: TenantIdentity): Record<string, string | number> {
  return {
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    branchId: tenant.branchId,
    generation: tenant.generation,
  };
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
