import { describe, expect, test } from "bun:test";
import {
  ProtocolError,
  createErrorEnvelope,
  createTenantCacheKey,
  createTenantContext,
  parseCorrelationId,
  parseTenantIdentity,
  parseTenantIdentityFromHeaders,
  resolveCorrelationId,
  serializeTenantIdentity,
  tenantHeaders,
  toErrorResponse,
} from "../src/index";

const rawTenant = {
  organizationId: "org_alpha",
  projectId: "project_alpha",
  environmentId: "production",
  branchId: "main_branch",
  generation: 7,
};

const correlationId = parseCorrelationId("018f2a11-2c8d-7cb4-9d46-1f1297e55cb8");

describe("tenant identifiers", () => {
  test("parses and serializes a complete tenant tuple", () => {
    const tenant = parseTenantIdentity(rawTenant);

    expect(serializeTenantIdentity(tenant)).toEqual(rawTenant);
    expect(Object.isFrozen(tenant)).toBe(true);
  });

  test("rejects incomplete and invalid tuples", () => {
    const invalidValues = [undefined, null, "", "UPPERCASE", "ab", "invalid/value"];

    for (const field of ["organizationId", "projectId", "environmentId", "branchId"] as const) {
      for (const value of invalidValues) {
        expect(() => parseTenantIdentity({ ...rawTenant, [field]: value })).toThrow(ProtocolError);
      }
    }

    expect(() => parseTenantIdentity({ ...rawTenant, generation: 0 })).toThrow(ProtocolError);
    expect(() => parseTenantIdentity({ ...rawTenant, generation: 1.5 })).toThrow(ProtocolError);
  });

  test("creates distinct cache keys for distinct generations", () => {
    const current = parseTenantIdentity(rawTenant);
    const recreated = parseTenantIdentity({ ...rawTenant, generation: 8 });

    expect(createTenantCacheKey(current, "schema:manifest")).toContain(":7");
    expect(createTenantCacheKey(current, "schema:manifest")).not.toBe(
      createTenantCacheKey(recreated, "schema:manifest"),
    );
  });
});

describe("HTTP boundary", () => {
  test("requires every tenant header including generation", () => {
    const headers = new Headers({
      [tenantHeaders.organizationId]: rawTenant.organizationId,
      [tenantHeaders.projectId]: rawTenant.projectId,
      [tenantHeaders.environmentId]: rawTenant.environmentId,
      [tenantHeaders.branchId]: rawTenant.branchId,
    });

    expect(() => parseTenantIdentityFromHeaders(headers)).toThrow(ProtocolError);
  });

  test("parses a complete HTTP tenant tuple", () => {
    const headers = new Headers({
      [tenantHeaders.organizationId]: rawTenant.organizationId,
      [tenantHeaders.projectId]: rawTenant.projectId,
      [tenantHeaders.environmentId]: rawTenant.environmentId,
      [tenantHeaders.branchId]: rawTenant.branchId,
      [tenantHeaders.generation]: String(rawTenant.generation),
    });

    expect(serializeTenantIdentity(parseTenantIdentityFromHeaders(headers))).toEqual(rawTenant);
  });

  test("preserves valid correlation IDs and replaces malformed ones", () => {
    const valid = new Headers({ [tenantHeaders.correlationId]: correlationId });
    const malformed = new Headers({ [tenantHeaders.correlationId]: "trace@example.com" });

    expect(resolveCorrelationId(valid)).toBe(correlationId);
    expect(() => parseCorrelationId(resolveCorrelationId(malformed))).not.toThrow();
    expect(resolveCorrelationId(malformed)).not.toBe("trace@example.com");
  });
});

describe("request context and public errors", () => {
  test("rejects capabilities scoped to another tenant", () => {
    const tenant = parseTenantIdentity(rawTenant);
    const otherTenant = parseTenantIdentity({ ...rawTenant, generation: 8 });

    expect(() =>
      createTenantContext({
        tenant,
        actor: { kind: "agent", id: "agent_alpha" },
        capabilities: [
          {
            id: "capability_alpha",
            tenant: otherTenant,
            actions: ["schema:read"],
            expiresAt: Date.now() + 60_000,
          },
        ],
        correlationId,
      }),
    ).toThrow(new ProtocolError("forbidden"));
  });

  test("freezes the context and redacts unexpected errors", () => {
    const tenant = parseTenantIdentity(rawTenant);
    const context = createTenantContext({
      tenant,
      actor: { kind: "user", id: "user_alpha" },
      capabilities: [],
      correlationId,
    });
    const response = toErrorResponse(new Error("secret@example.com: stack trace"), correlationId);

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.capabilities)).toBe(true);
    expect(response).toEqual({
      status: 503,
      body: createErrorEnvelope("infrastructure", correlationId),
    });
    expect(JSON.stringify(response)).not.toContain("secret@example.com");
    expect(JSON.stringify(response)).not.toContain("stack trace");
  });

  test("maps each public error category to a distinct status", () => {
    const statuses = [
      "validation",
      "auth",
      "forbidden",
      "conflict",
      "quota",
      "unsupported",
      "infrastructure",
    ].map(
      (code) =>
        toErrorResponse(new ProtocolError(code as ProtocolError["code"]), correlationId).status,
    );

    expect(new Set(statuses).size).toBe(statuses.length);
  });
});
