import { createFileRoute } from "@tanstack/react-router";

import { handleVerificationCodeRequest } from '@/lib/mekka-platform-handlers'

export const handleRequest = handleVerificationCodeRequest

export const Route = createFileRoute(
  "/api/platform/project-auth/$ref/verification-code",
)({
  server: { handlers: { GET: handleRequest } },
});
