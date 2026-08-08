import { createHash } from "node:crypto";
import {
  createErrorEnvelope,
  type ErrorCode,
  type OrganizationId,
  ProtocolError,
  parseOrganizationId,
  resolveCorrelationId,
} from "@mekka/protocol";
import { Elysia } from "elysia";

export * from "./connect-analyzer";

export type EnabledModule = "auth" | "storage" | "realtime" | "functions";
export type StarterTemplate = "empty" | "saas" | "marketplace" | "chat" | "mobile" | "import";
export type ProvisioningPhase =
  | "catalog"
  | "database"
  | "credentials"
  | "health"
  | "cleanup"
  | "complete";
export type ProvisioningStatus = "provisioning" | "ready" | "failed";

export type OnboardingRequest = Readonly<{
  organizationName: string;
  projectName: string;
  region: string;
  template: StarterTemplate;
  enabledModules: readonly EnabledModule[];
}>;

export type ConnectionDetails = Readonly<{
  apiUrl: string;
  publishableKey: string;
}>;

export type OnboardingRecord = Readonly<{
  id: string;
  actorId: string;
  idempotencyKey: string;
  fingerprint: string;
  request: OnboardingRequest;
  organizationId: OrganizationId;
  projectId: string;
  status: ProvisioningStatus;
  phase: ProvisioningPhase;
  errorCode: ErrorCode | null;
  connection: ConnectionDetails | null;
}>;

export type OnboardingRepository = Readonly<{
  claimIdempotency(record: OnboardingRecord): Readonly<{
    record: OnboardingRecord;
    created: boolean;
  }>;
  findById(id: string): OnboardingRecord | null;
  save(record: OnboardingRecord): void;
}>;

export type OnboardingProvisioner = Readonly<{
  provision(
    input: Readonly<{ record: OnboardingRecord; onPhase: (phase: ProvisioningPhase) => void }>,
  ): ConnectionDetails;
  cleanup(input: Readonly<{ record: OnboardingRecord }>): void;
  healthCheck(input: Readonly<{ record: OnboardingRecord; connection: ConnectionDetails }>): void;
}>;

export type OnboardingService = Readonly<{
  create(actorId: string, idempotencyKey: string, input: unknown): OnboardingRecord;
  retry(actorId: string, idempotencyKey: string, id: string): OnboardingRecord;
  get(actorId: string, id: string): OnboardingRecord;
}>;

const idempotencyKeyPattern = /^[A-Za-z0-9_-]{16,128}$/;
const identifierPattern = /^[a-z][a-z0-9-]{2,63}$/;
const projectNamePattern = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,63}$/;
const regions = new Set(["us-east-1", "us-west-2", "eu-central-1"]);
const templates = new Set<StarterTemplate>([
  "empty",
  "saas",
  "marketplace",
  "chat",
  "mobile",
  "import",
]);
const modules = new Set<EnabledModule>(["auth", "storage", "realtime", "functions"]);

export function createOnboardingService(
  input: Readonly<{
    repository: OnboardingRepository;
    provisioner: OnboardingProvisioner;
    allocateId?: () => string;
  }>,
): OnboardingService {
  const allocateId = input.allocateId ?? (() => crypto.randomUUID());

  return Object.freeze({
    create(actorId, idempotencyKey, value) {
      requireActorId(actorId);
      requireIdempotencyKey(idempotencyKey);
      const request = parseRequest(value);
      const fingerprint = fingerprintRequest(request);
      const record = Object.freeze({
        id: allocateId(),
        actorId,
        idempotencyKey,
        fingerprint,
        request,
        organizationId: parseOrganizationId(`org-${slug(request.organizationName)}`),
        projectId: `prj-${slug(request.projectName)}`,
        status: "provisioning" as const,
        phase: "catalog" as const,
        errorCode: null,
        connection: null,
      });
      const claimed = input.repository.claimIdempotency(record);
      if (!claimed.created) {
        if (claimed.record.fingerprint !== fingerprint) throw new OnboardingError("conflict");
        return claimed.record;
      }
      return run(input.repository, input.provisioner, record);
    },
    retry(actorId, idempotencyKey, id) {
      requireActorId(actorId);
      requireIdempotencyKey(idempotencyKey);
      const existing = readOwnedRecord(input.repository, actorId, id);
      if (existing.status !== "failed") throw new OnboardingError("conflict");
      const retrying = Object.freeze({
        ...existing,
        idempotencyKey,
        status: "provisioning" as const,
        phase: "catalog" as const,
        errorCode: null,
      });
      input.repository.save(retrying);
      return run(input.repository, input.provisioner, retrying);
    },
    get(actorId, id) {
      requireActorId(actorId);
      return readOwnedRecord(input.repository, actorId, id);
    },
  });
}

export function createOnboardingApp(
  input: Readonly<{
    authenticate(request: Request): Readonly<{ actorId: string }>;
    service: OnboardingService;
  }>,
) {
  return new Elysia({ name: "onboarding-core" })
    .post("/onboarding", async ({ request }) =>
      handle(request, async () => {
        const actor = input.authenticate(request);
        return input.service.create(
          actor.actorId,
          readIdempotencyKey(request.headers),
          await request.json(),
        );
      }),
    )
    .get("/onboarding/:id", ({ request, params }) =>
      handle(request, () => input.service.get(input.authenticate(request).actorId, params.id)),
    )
    .post("/onboarding/:id/retry", ({ request, params }) =>
      handle(request, () =>
        input.service.retry(
          input.authenticate(request).actorId,
          readIdempotencyKey(request.headers),
          params.id,
        ),
      ),
    );
}

function run(
  repository: OnboardingRepository,
  provisioner: OnboardingProvisioner,
  record: OnboardingRecord,
): OnboardingRecord {
  let current = record;
  const onPhase = (phase: ProvisioningPhase) => {
    current = Object.freeze({ ...current, phase });
    repository.save(current);
  };
  try {
    const connection = provisioner.provision({ record: current, onPhase });
    onPhase("health");
    provisioner.healthCheck({ record: current, connection });
    current = Object.freeze({
      ...current,
      status: "ready" as const,
      phase: "complete" as const,
      connection,
    });
    repository.save(current);
    return current;
  } catch (error) {
    // A failed request is never routable: cleanup completes before the failed record is published.
    try {
      onPhase("cleanup");
      provisioner.cleanup({ record: current });
    } catch {
      // Cleanup is retried by the infrastructure reconciler; the project remains inaccessible.
    }
    current = Object.freeze({
      ...current,
      status: "failed" as const,
      phase: "cleanup" as const,
      errorCode: toErrorCode(error),
      connection: null,
    });
    repository.save(current);
    return current;
  }
}

async function handle(
  request: Request,
  operation: () => Promise<OnboardingRecord> | OnboardingRecord,
): Promise<Response> {
  const correlationId = resolveCorrelationId(request.headers);
  try {
    return Response.json(await operation(), { headers: { "x-correlation-id": correlationId } });
  } catch (error) {
    const code =
      error instanceof OnboardingError
        ? error.code
        : error instanceof ProtocolError
          ? error.code
          : "infrastructure";
    return Response.json(createErrorEnvelope(code, correlationId), {
      status: statusFor(code),
      headers: { "x-correlation-id": correlationId },
    });
  }
}

function parseRequest(value: unknown): OnboardingRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OnboardingError("validation");
  const record = value as Record<string, unknown>;
  const organizationName = readName(record.organizationName);
  const projectName = readProjectName(record.projectName);
  const region = readRegion(record.region);
  const template = readTemplate(record.template);
  const enabledModules = readModules(record.enabledModules);
  return Object.freeze({ organizationName, projectName, region, template, enabledModules });
}

function readName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 3 || value.trim().length > 64)
    throw new OnboardingError("validation");
  return value.trim();
}

function readProjectName(value: unknown): string {
  if (typeof value !== "string" || !projectNamePattern.test(value.trim()))
    throw new OnboardingError("validation");
  return value.trim();
}

function readRegion(value: unknown): string {
  if (typeof value !== "string" || !regions.has(value)) throw new OnboardingError("validation");
  return value;
}

function readTemplate(value: unknown): StarterTemplate {
  if (typeof value !== "string" || !templates.has(value as StarterTemplate))
    throw new OnboardingError("validation");
  return value as StarterTemplate;
}

function readModules(value: unknown): readonly EnabledModule[] {
  if (
    !Array.isArray(value) ||
    value.length > modules.size ||
    value.some((module) => typeof module !== "string" || !modules.has(module as EnabledModule))
  )
    throw new OnboardingError("validation");
  const unique = [...new Set(value as EnabledModule[])];
  if (unique.length !== value.length) throw new OnboardingError("validation");
  return Object.freeze(unique.sort());
}

function readIdempotencyKey(headers: Headers): string {
  const value = headers.get("idempotency-key");
  if (value === null || !idempotencyKeyPattern.test(value)) throw new OnboardingError("validation");
  return value;
}

function readOwnedRecord(
  repository: OnboardingRepository,
  actorId: string,
  id: string,
): OnboardingRecord {
  const record = repository.findById(id);
  if (record === null || record.actorId !== actorId) throw new OnboardingError("forbidden");
  return record;
}

function requireActorId(value: string): void {
  if (!identifierPattern.test(value)) throw new OnboardingError("auth");
}

function requireIdempotencyKey(value: string): void {
  if (!idempotencyKeyPattern.test(value)) throw new OnboardingError("validation");
}

function slug(value: string): string {
  const result = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return result.length >= 3 ? result.slice(0, 59) : "new";
}

function fingerprintRequest(request: OnboardingRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function toErrorCode(error: unknown): ErrorCode {
  return error instanceof OnboardingError ? error.code : "infrastructure";
}

function statusFor(code: ErrorCode): number {
  if (code === "auth") return 401;
  if (code === "forbidden") return 403;
  if (code === "conflict") return 409;
  if (code === "quota") return 429;
  if (code === "unsupported") return 501;
  if (code === "validation") return 400;
  return 503;
}

class OnboardingError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
    this.name = "OnboardingError";
  }
}
