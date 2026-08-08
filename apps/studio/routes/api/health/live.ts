import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/live")({
  server: {
    handlers: {
      GET: () => Response.json({ status: "ok" }),
    },
  },
});
