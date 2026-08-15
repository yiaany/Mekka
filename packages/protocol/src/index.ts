declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & {
  readonly [brand]: Name;
};

export type OrganizationId = Brand<string, "OrganizationId">;
export type ProjectId = Brand<string, "ProjectId">;
export type EnvironmentId = Brand<string, "EnvironmentId">;
export type BranchId = Brand<string, "BranchId">;
export type Generation = Brand<number, "Generation">;
export type CorrelationId = Brand<string, "CorrelationId">;

export type TenantIdentity = Readonly<{
  organizationId: OrganizationId;
  projectId: ProjectId;
  environmentId: EnvironmentId;
  branchId: BranchId;
  generation: Generation;
}>;

export type TenantIdentityInput = Readonly<{
  organizationId: unknown;
  projectId: unknown;
  environmentId: unknown;
  branchId: unknown;
  generation: unknown;
}>;

export type SerializedTenantIdentity = Readonly<{
  organizationId: string;
  projectId: string;
  environmentId: string;
  branchId: string;
  generation: number;
}>;

export type Actor = Readonly<{
  kind: "user" | "service" | "agent";
  id: string;
}>;

export type Capability = Readonly<{
  id: string;
  tenant: TenantIdentity;
  actions: readonly string[];
  expiresAt: number;
}>;

export type TenantContext = Readonly<{
  tenant: TenantIdentity;
  actor: Actor;
  capabilities: readonly Capability[];
  correlationId: CorrelationId;
}>;

export type ErrorCode =
  | "validation"
  | "auth"
  | "forbidden"
  | "conflict"
  | "quota"
  | "unsupported"
  | "not_found"
  | "infrastructure";

export type ErrorEnvelope = Readonly<{
  error: Readonly<{
    code: ErrorCode;
    message: string;
    correlationId: CorrelationId;
  }>;
}>;

export type ErrorResponse = Readonly<{
  status: number;
  body: ErrorEnvelope;
}>;

export type HealthStatus = Readonly<{
  status: "ok";
  service: string;
}>;

export const tenantHeaders = Object.freeze({
  organizationId: "x-mekka-organization-id",
  projectId: "x-mekka-project-id",
  environmentId: "x-mekka-environment-id",
  branchId: "x-mekka-branch-id",
  generation: "x-mekka-generation",
  correlationId: "x-correlation-id",
});

const identifierPattern = /^[a-z][a-z0-9_-]{2,63}$/;
const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeActorOrCapabilityIdPattern = /^[A-Za-z0-9_-]{3,128}$/;
const safeActionPattern = /^[a-z][a-z0-9_:-]{1,127}$/;

const errorDetails = {
  validation: { status: 400, message: "Request validation failed." },
  auth: { status: 401, message: "Authentication is required." },
  forbidden: { status: 403, message: "The requested action is not permitted." },
  conflict: { status: 409, message: "The request conflicts with the current resource state." },
  quota: { status: 429, message: "A resource quota was exceeded." },
  unsupported: { status: 501, message: "The requested operation is not supported." },
  not_found: { status: 404, message: "The requested resource does not exist." },
  infrastructure: { status: 503, message: "The service is temporarily unavailable." },
} as const satisfies Record<ErrorCode, Readonly<{ status: number; message: string }>>;

export class ProtocolError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(errorDetails[code].message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function parseOrganizationId(value: unknown): OrganizationId {
  return parseIdentifier<"OrganizationId">(value);
}

export function parseProjectId(value: unknown): ProjectId {
  return parseIdentifier<"ProjectId">(value);
}

export function parseEnvironmentId(value: unknown): EnvironmentId {
  return parseIdentifier<"EnvironmentId">(value);
}

export function parseBranchId(value: unknown): BranchId {
  return parseIdentifier<"BranchId">(value);
}

export function parseGeneration(value: unknown): Generation {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProtocolError("validation");
  }

  return value as Generation;
}

export function parseCorrelationId(value: unknown): CorrelationId {
  if (typeof value !== "string" || !correlationIdPattern.test(value)) {
    throw new ProtocolError("validation");
  }

  return value.toLowerCase() as CorrelationId;
}

export function createCorrelationId(): CorrelationId {
  return crypto.randomUUID() as CorrelationId;
}

export function resolveCorrelationId(headers: Headers): CorrelationId {
  const value = headers.get(tenantHeaders.correlationId);

  if (value === null) {
    return createCorrelationId();
  }

  try {
    return parseCorrelationId(value);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return createCorrelationId();
    }

    throw error;
  }
}

export function parseTenantIdentity(input: TenantIdentityInput): TenantIdentity {
  return Object.freeze({
    organizationId: parseOrganizationId(input.organizationId),
    projectId: parseProjectId(input.projectId),
    environmentId: parseEnvironmentId(input.environmentId),
    branchId: parseBranchId(input.branchId),
    generation: parseGeneration(input.generation),
  });
}

export function serializeTenantIdentity(tenant: TenantIdentity): SerializedTenantIdentity {
  return Object.freeze({
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
    environmentId: tenant.environmentId,
    branchId: tenant.branchId,
    generation: tenant.generation,
  });
}

export function parseTenantIdentityFromHeaders(headers: Headers): TenantIdentity {
  return parseTenantIdentity({
    organizationId: headers.get(tenantHeaders.organizationId),
    projectId: headers.get(tenantHeaders.projectId),
    environmentId: headers.get(tenantHeaders.environmentId),
    branchId: headers.get(tenantHeaders.branchId),
    generation: parseGenerationHeader(headers.get(tenantHeaders.generation)),
  });
}

export function createTenantContext(
  input: Readonly<{
    tenant: TenantIdentity;
    actor: Actor;
    capabilities: readonly Capability[];
    correlationId: CorrelationId;
  }>,
): TenantContext {
  const tenant = parseTenantIdentity(input.tenant);
  const correlationId = parseCorrelationId(input.correlationId);
  validateActor(input.actor);
  validateCapabilities(input.capabilities, tenant);

  return Object.freeze({
    tenant,
    actor: Object.freeze({ ...input.actor }),
    capabilities: Object.freeze(
      input.capabilities.map((capability) =>
        Object.freeze({
          ...capability,
          tenant: parseTenantIdentity(capability.tenant),
          actions: Object.freeze([...capability.actions]),
        }),
      ),
    ),
    correlationId,
  });
}

export function createTenantContextFromHeaders(
  headers: Headers,
  authentication: Readonly<{ actor: Actor; capabilities: readonly Capability[] }>,
): TenantContext {
  return createTenantContext({
    tenant: parseTenantIdentityFromHeaders(headers),
    actor: authentication.actor,
    capabilities: authentication.capabilities,
    correlationId: resolveCorrelationId(headers),
  });
}

export function hasCapability(context: TenantContext, action: string, now = Date.now()): boolean {
  return context.capabilities.some(
    (capability) => capability.expiresAt > now && capability.actions.includes(action),
  );
}

export function createTenantCacheKey(tenant: TenantIdentity, namespace: string): string {
  if (!safeActionPattern.test(namespace)) {
    throw new ProtocolError("validation");
  }

  const parsedTenant = parseTenantIdentity(tenant);

  return [
    "tenant-v1",
    namespace,
    parsedTenant.organizationId,
    parsedTenant.projectId,
    parsedTenant.environmentId,
    parsedTenant.branchId,
    parsedTenant.generation,
  ].join(":");
}

export function createErrorEnvelope(code: ErrorCode, correlationId: CorrelationId): ErrorEnvelope {
  return Object.freeze({
    error: Object.freeze({
      code,
      message: errorDetails[code].message,
      correlationId,
    }),
  });
}

export function toErrorResponse(error: unknown, correlationId: CorrelationId): ErrorResponse {
  const code = error instanceof ProtocolError ? error.code : "infrastructure";

  return Object.freeze({
    status: errorDetails[code].status,
    body: createErrorEnvelope(code, correlationId),
  });
}

function parseIdentifier<Name extends string>(value: unknown): Brand<string, Name> {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new ProtocolError("validation");
  }

  return value as Brand<string, Name>;
}

function parseGenerationHeader(value: string | null): unknown {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    return value;
  }

  return Number(value);
}

function validateActor(actor: Actor): void {
  if (
    (actor.kind !== "user" && actor.kind !== "service" && actor.kind !== "agent") ||
    !safeActorOrCapabilityIdPattern.test(actor.id)
  ) {
    throw new ProtocolError("validation");
  }
}

function validateCapabilities(capabilities: readonly Capability[], tenant: TenantIdentity): void {
  for (const capability of capabilities) {
    if (!safeActorOrCapabilityIdPattern.test(capability.id)) {
      throw new ProtocolError("validation");
    }

    if (!Number.isSafeInteger(capability.expiresAt) || capability.expiresAt < 1) {
      throw new ProtocolError("validation");
    }

    if (
      capability.actions.length === 0 ||
      capability.actions.some((action) => !safeActionPattern.test(action))
    ) {
      throw new ProtocolError("validation");
    }

    if (!sameTenant(capability.tenant, tenant)) {
      throw new ProtocolError("forbidden");
    }
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
