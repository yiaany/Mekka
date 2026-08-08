import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/api/platform/project-auth/$ref/verification-code",
)({
  server: { handlers: { GET: handleRequest } },
});

async function handleRequest({
  request,
  params,
}: {
  request: Request;
  params: { ref: string };
}): Promise<Response> {
  if (process.env.MEKKA_LOCAL_DEV !== "1") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (params.ref !== "local") return Response.json({ error: "not_found" }, { status: 404 });
  const backendUrl = process.env.STUDIO_BACKEND_API_URL;
  if (!backendUrl) return Response.json({ error: "unavailable" }, { status: 503 });
  const email = new URL(request.url).searchParams.get("email") ?? "";
  return fetch(
    `${backendUrl.replace(/\/$/, "")}/auth-local/verification-code?email=${encodeURIComponent(email)}`,
    { signal: AbortSignal.timeout(5_000) },
  );
}
