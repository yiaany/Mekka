import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/$")({
  server: {
    handlers: {
      GET: proxyAuth,
      POST: proxyAuth,
    },
  },
});

async function proxyAuth({ request }: { request: Request }): Promise<Response> {
  const backendUrl = process.env.STUDIO_BACKEND_API_URL;
  if (!backendUrl) return Response.json({ error: "unavailable" }, { status: 503 });
  const incoming = new URL(request.url);
  try {
    const body = request.method === "GET" ? undefined : await request.arrayBuffer();
    const headers = new Headers(request.headers);
    for (const name of [
      "connection",
      "content-length",
      "expect",
      "host",
      "transfer-encoding",
    ]) {
      headers.delete(name);
    }
    return await fetch(`${backendUrl.replace(/\/$/, "")}${incoming.pathname}${incoming.search}`, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
  } catch (error) {
    console.error("Project Auth proxy failed", error);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
