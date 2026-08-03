import { Elysia } from "elysia";
import type { HealthStatus } from "@mekka/protocol";

const HEALTH_STATUS: HealthStatus = {
  status: "ok",
  service: "health-service",
};

export const app = new Elysia({ name: "health-service" }).get("/health", () => HEALTH_STATUS);
