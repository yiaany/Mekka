import { tenantHeaders } from "@mekka/protocol";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health/ready")({
  server: {
    handlers: {
      GET: checkReadiness,
    },
  },
});

async function checkReadiness(): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL;
  if (!backendUrl) return unavailable();

  const headers = new Headers({
    accept: "application/json",
    [tenantHeaders.organizationId]:
      process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? "org-local",
    [tenantHeaders.projectId]: "local",
    [tenantHeaders.environmentId]:
      process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? "env-local",
    [tenantHeaders.branchId]:
      process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? "branch-main",
    [tenantHeaders.generation]:
      process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? "1",
  });
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN;
  if (internalProxyToken) headers.set("x-mekka-internal-proxy", internalProxyToken);

  try {
    const response = await fetch(
      `${backendUrl.replace(/\/$/, "")}/schema/health`,
      { headers, signal: AbortSignal.timeout(2_000) },
    );
    if (!response.ok) return unavailable();
    return Response.json(
      { status: "ready" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return unavailable();
  }
}

function unavailable(): Response {
  return Response.json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
