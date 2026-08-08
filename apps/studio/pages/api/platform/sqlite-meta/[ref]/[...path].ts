import type { NextApiRequest, NextApiResponse } from "next";

import { tenantHeaders } from "@mekka/protocol";

const readPaths = new Set(["tables", "schema/health", "columns", "indexes"]);
const readPathPatterns = [
  /^tables\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
];
const mutationPaths = [
  /^tables$/,
  /^tables\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^columns$/,
  /^columns\/[A-Za-z_][A-Za-z0-9_]{0,63}\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^indexes$/,
  /^rows\/[A-Za-z_][A-Za-z0-9_]{0,63}$/,
  /^sql$/,
];
const maxUpstreamResponseBytes = 2 * 1024 * 1024;
const forwardedHeaders = [
  tenantHeaders.correlationId,
] as const;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const path = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : req.query.path;
  const projectRef = Array.isArray(req.query.ref)
    ? req.query.ref[0]
    : req.query.ref;
  const isReadPath =
    path !== undefined &&
    (readPaths.has(path) ||
      readPathPatterns.some((pattern) => pattern.test(path)));
  const isMutationPath =
    path !== undefined && mutationPaths.some((pattern) => pattern.test(path));
  const isAllowedMethod =
    req.method === "GET"
      ? isReadPath
      : ["POST", "PATCH", "DELETE"].includes(req.method ?? "") &&
        isMutationPath;
  if (!path || !isAllowedMethod || projectRef !== "local") {
    return res.status(404).json({ error: { message: "Resource not found" } });
  }
  const internalProxyToken = process.env.MEKKA_INTERNAL_PROXY_TOKEN;
  const isTrustedProductionRequest =
    internalProxyToken !== undefined &&
    req.headers["x-mekka-internal-proxy"] === internalProxyToken;
  const isLoopbackDevelopment =
    process.env.NODE_ENV !== "production" &&
    (req.socket === undefined || isLoopback(req.socket.remoteAddress));
  if (!isTrustedProductionRequest && !isLoopbackDevelopment) {
    return res
      .status(401)
      .json({ error: { message: "Trusted Studio proxy is required" } });
  }
  if (
    req.method !== "GET" &&
    typeof req.headers["idempotency-key"] !== "string"
  ) {
    return res
      .status(400)
      .json({ error: { message: "Idempotency key is required" } });
  }
  if (
    req.headers[tenantHeaders.projectId] !== undefined &&
    req.headers[tenantHeaders.projectId] !== projectRef
  ) {
    return res.status(403).json({ error: { message: "Tenant mismatch" } });
  }

  const backendUrl = process.env.STUDIO_BACKEND_API_URL;
  if (!backendUrl) {
    return res
      .status(503)
      .json({ error: { message: "Studio backend is not configured" } });
  }

  const headers = new Headers({ accept: "application/json" });
  if (internalProxyToken) headers.set("x-mekka-internal-proxy", internalProxyToken);
  for (const name of forwardedHeaders) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  headers.set(
    tenantHeaders.organizationId,
    process.env.NEXT_PUBLIC_STUDIO_ORGANIZATION_ID ?? "org-local",
  );
  headers.set(tenantHeaders.projectId, projectRef);
  headers.set(
    tenantHeaders.environmentId,
    process.env.NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID ?? "env-local",
  );
  headers.set(
    tenantHeaders.branchId,
    process.env.NEXT_PUBLIC_STUDIO_BRANCH_ID ?? "branch-main",
  );
  headers.set(
    tenantHeaders.generation,
    process.env.NEXT_PUBLIC_STUDIO_GENERATION ?? "1",
  );
  if (typeof req.headers["idempotency-key"] === "string") {
    headers.set("idempotency-key", req.headers["idempotency-key"]);
  }
  if (req.method !== "GET") headers.set("content-type", "application/json");

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  req.once("aborted", () => controller.abort());
  try {
    const requestUrl = new URL(req.url ?? "/", "http://studio.local");
    const response = await fetch(
      `${backendUrl.replace(/\/$/, "")}/${path}${requestUrl.search}`,
      {
        method: req.method,
        headers,
        ...(req.method === "GET" ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      },
    );
    const body = await readBoundedBody(response);
    const contentType = response.headers.get("content-type");
    const correlationId = response.headers.get(tenantHeaders.correlationId);
    if (contentType) res.setHeader("content-type", contentType);
    if (correlationId)
      res.setHeader(tenantHeaders.correlationId, correlationId);
    return res.status(response.status).send(body);
  } catch (error) {
    if (timedOut) {
      return res.status(504).json({ error: { message: "Studio backend timed out" } });
    }
    if (controller.signal.aborted) return;
    if (error instanceof UpstreamResponseTooLargeError) {
      return res.status(502).json({ error: { message: "Studio backend response is invalid" } });
    }
    return res
      .status(503)
      .json({ error: { message: "Studio backend is unavailable" } });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxUpstreamResponseBytes) {
    await response.body?.cancel();
    throw new UpstreamResponseTooLargeError();
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxUpstreamResponseBytes) {
        await reader.cancel();
        throw new UpstreamResponseTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
}

class UpstreamResponseTooLargeError extends Error {}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}
