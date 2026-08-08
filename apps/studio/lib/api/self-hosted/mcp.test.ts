import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDevelopmentOperations } from "./mcp";

vi.mock("./settings", () => ({
  getProjectSettings: vi.fn(),
}));

vi.mock("./generate-types", () => ({
  generateTypescriptTypes: vi.fn(),
}));

describe("api/self-hosted/mcp", () => {
  describe("getDevelopmentOperations.getPublishableKeys", () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      vi.unstubAllEnvs();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("returns a publishable-typed key from MEKKA_PUBLISHABLE_KEY when set", async () => {
      vi.stubEnv("MEKKA_PUBLISHABLE_KEY", "mk_publishable_abc");

      const ops = getDevelopmentOperations({});
      const keys = await ops.getPublishableKeys("default");

      expect(keys).toEqual([
        {
          api_key: "mk_publishable_abc",
          name: "publishable",
          type: "publishable",
        },
      ]);
    });

    it("does not fall back to legacy project keys", async () => {
      vi.stubEnv("MEKKA_PUBLISHABLE_KEY", "");
      const ops = getDevelopmentOperations({});
      await expect(ops.getPublishableKeys("default")).rejects.toThrow(
        "MEKKA_PUBLISHABLE_KEY is not configured",
      );
    });
  });
});
