import { describe, expect, test } from "bun:test";
import { createOnboardingApp, createOnboardingService, type OnboardingRecord } from "../src/index";

describe("onboarding provisioning", () => {
  test("is idempotent, runs health before publishing connection details, and creates safe defaults", () => {
    const fixture = createFixture();
    const request = input();
    const first = fixture.service.create("user-main", "quick-setup-create1", request);
    const retry = fixture.service.create("user-main", "quick-setup-create1", request);

    expect(first).toEqual(retry);
    expect(first.status).toBe("ready");
    expect(first.phase).toBe("complete");
    expect(first.request.enabledModules).toEqual(["auth", "storage"]);
    expect(first.connection).toEqual({
      apiUrl: "https://api.mekka.test/prj-new-project",
      publishableKey: "pk_live_safe",
    });
    expect(fixture.events).toEqual(["catalog", "database", "credentials", "health"]);
  });

  test("rejects idempotency reuse with changed input and hides failed resources after cleanup", () => {
    const fixture = createFixture({ shouldFailHealth: true });
    const failed = fixture.service.create("user-main", "quick-setup-create1", input());

    expect(failed).toMatchObject({ status: "failed", phase: "cleanup", connection: null });
    expect(fixture.events).toEqual(["catalog", "database", "credentials", "health", "cleanup"]);
    expect(() =>
      fixture.service.create(
        "user-main",
        "quick-setup-create1",
        input({ projectName: "Changed Project" }),
      ),
    ).toThrow("conflict");
  });

  test("retries only the actor-owned failed provisioning and the HTTP boundary redacts failures", async () => {
    const fixture = createFixture({ shouldFailHealth: true });
    const failed = fixture.service.create("user-main", "quick-setup-create1", input());
    fixture.setFailHealth(false);
    const retried = fixture.service.retry("user-main", "quick-setup-retry01", failed.id);
    expect(retried.status).toBe("ready");
    expect(() => fixture.service.get("user-other", failed.id)).toThrow("forbidden");

    const app = createOnboardingApp({
      authenticate: () => ({ actorId: "user-main" }),
      service: fixture.service,
    });
    const response = await app.handle(
      new Request("http://control.local/onboarding", { method: "POST", body: "bad" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "validation" } });
  });
});

function createFixture(options: { shouldFailHealth?: boolean } = {}) {
  const records = new Map<string, OnboardingRecord>();
  const idempotency = new Map<string, string>();
  const events: string[] = [];
  const state = { shouldFailHealth: options.shouldFailHealth ?? false };
  const service = createOnboardingService({
    repository: {
      claimIdempotency: (record) => {
        const key = `${record.actorId}:${record.idempotencyKey}`;
        const existingId = idempotency.get(key);
        if (existingId !== undefined) {
          return { record: records.get(existingId) ?? record, created: false };
        }
        idempotency.set(key, record.id);
        records.set(record.id, record);
        return { record, created: true };
      },
      findById: (id) => records.get(id) ?? null,
      save: (record) => {
        records.set(record.id, record);
        idempotency.set(`${record.actorId}:${record.idempotencyKey}`, record.id);
      },
    },
    provisioner: {
      provision: ({ record, onPhase }) => {
        onPhase("catalog");
        events.push("catalog");
        onPhase("database");
        events.push("database");
        onPhase("credentials");
        events.push("credentials");
        return {
          apiUrl: `https://api.mekka.test/${record.projectId}`,
          publishableKey: "pk_live_safe",
        };
      },
      healthCheck: () => {
        events.push("health");
        if (state.shouldFailHealth) throw new Error("database unavailable");
      },
      cleanup: () => events.push("cleanup"),
    },
    allocateId: () => "onboarding-001",
  });
  return {
    service,
    events,
    setFailHealth: (value: boolean) => {
      state.shouldFailHealth = value;
    },
  };
}

function input(overrides: Partial<ReturnType<typeof baseInput>> = {}) {
  return { ...baseInput(), ...overrides };
}

function baseInput() {
  return {
    organizationName: "Mekka Team",
    projectName: "New Project",
    region: "us-east-1",
    template: "saas" as const,
    enabledModules: ["storage", "auth"],
  };
}
