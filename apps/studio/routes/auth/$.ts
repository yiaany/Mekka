import { createFileRoute } from "@tanstack/react-router";

import { handleProjectAuthProxy } from '@/lib/mekka-platform-handlers'

export const handleRequest = handleProjectAuthProxy

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: handleRequest,
      POST: handleRequest,
    },
  },
});
