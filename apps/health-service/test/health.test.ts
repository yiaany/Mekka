import { describe, expect, test } from "bun:test";
import { requireHeader } from "@mekka/testkit";
import { app } from "../src/app";
import { loadServiceConfig } from "../src/config";

describe("health service", () => {
  test("returns a stable health response", async () => {
    const response = await app.handle(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    expect(requireHeader(response.headers, "content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ status: "ok", service: "health-service" });
  });

  test("rejects invalid ports before starting", () => {
    expect(() => loadServiceConfig({ PORT: "0" })).toThrow(
      "PORT must be an integer between 1 and 65535.",
    );
    expect(() => loadServiceConfig({ PORT: "not-a-port" })).toThrow(
      "PORT must be an integer between 1 and 65535.",
    );
  });
});
