import { beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectSettings } from "./settings";

vi.mock("./util", () => ({
  assertSelfHosted: vi.fn(),
}));

vi.mock("@/lib/constants/api", () => ({
  PROJECT_ENDPOINT: "localhost:8000",
  PROJECT_ENDPOINT_PROTOCOL: "http",
  PROJECT_DB_HOST: "localhost",
}));

describe("api/self-hosted/settings", () => {
  let mockAssertSelfHosted: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const util = await import("./util");
    mockAssertSelfHosted = vi.mocked(util.assertSelfHosted);
  });

  describe("getProjectSettings", () => {
    it("should call assertSelfHosted", () => {
      getProjectSettings();

      expect(mockAssertSelfHosted).toHaveBeenCalled();
    });

    it("should return project settings with correct structure", () => {
      const settings = getProjectSettings();

      expect(settings).toHaveProperty("app_config");
      expect(settings).toHaveProperty("cloud_provider");
      expect(settings).toHaveProperty("db_dns_name");
      expect(settings).toHaveProperty("db_host");
      expect(settings).toHaveProperty("db_name");
      expect(settings).toHaveProperty("jwt_secret");
      expect(settings).toHaveProperty("service_api_keys");
    });

    it("should return correct default values", () => {
      const settings = getProjectSettings();

      expect(settings.cloud_provider).toBe("AWS");
      expect(settings.db_host).toBe("localhost");
      expect(settings.db_name).toBe("sqlite");
      expect(settings.db_port).toBe(0);
      expect(settings.db_user).toBe("local");
      expect(settings.ref).toBe("local");
      expect(settings.region).toBe("local");
      expect(settings.status).toBe("ACTIVE_HEALTHY");
      expect(settings.ssl_enforced).toBe(false);
    });

    it("should include app_config with endpoint and protocol", () => {
      const settings = getProjectSettings();

      expect(settings.app_config).toEqual({
        db_schema: "main",
        endpoint: "localhost:8000",
        storage_endpoint: "localhost:8000",
        protocol: "http",
      });
    });

    it("should never expose service API keys", () => {
      const settings = getProjectSettings();

      expect(settings.service_api_keys).toEqual([]);
      expect(settings.jwt_secret).toBe("");
    });

    it("should not expose secret environment variables", async () => {
      vi.stubEnv("AUTH_JWT_SECRET", "custom-jwt-secret-with-at-least-32-chars");
      vi.stubEnv("DEFAULT_PROJECT_NAME", "My Custom Project");
      vi.stubEnv("SUPABASE_SERVICE_KEY", "custom-service-key");
      vi.stubEnv("SUPABASE_ANON_KEY", "custom-anon-key");

      // Need to re-import to pick up new env vars
      vi.resetModules();

      const { getProjectSettings: getSettings } = await import("./settings");
      const settings = getSettings();

      expect(settings.jwt_secret).toBe("");
      expect(settings.name).toBe("My Custom Project");
      expect(settings.service_api_keys).toEqual([]);
    });

    it("should not require a legacy JWT secret", async () => {
      vi.unstubAllEnvs();

      vi.resetModules();
      const { getProjectSettings: getSettings } = await import("./settings");
      expect(getSettings().jwt_secret).toBe("");
    });

    it("should use default project name when not set", async () => {
      vi.unstubAllEnvs();

      vi.resetModules();
      const { getProjectSettings: getSettings } = await import("./settings");
      const settings = getSettings();

      expect(settings.name).toBe("Local Project");
    });

    it("should have correct db_ip_addr_config", () => {
      const settings = getProjectSettings();

      expect(settings.db_ip_addr_config).toBe("legacy");
    });

    it("should have correct inserted_at timestamp", () => {
      const settings = getProjectSettings();

      expect(settings.inserted_at).toBe("2021-08-02T06:40:40.646Z");
    });
  });
});
