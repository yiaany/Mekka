const BLOCKED_API_PREFIXES = [
  "/api/ai/",
  "/api/v1/",
  "/api/platform/pg-meta/",
  "/api/platform/auth/",
  "/api/platform/storage/",
] as const;

const BLOCKED_API_SEGMENTS = [
  "/api-keys",
  "/config/postgres",
  "/config/postgrest",
  "/config/pgbouncer",
] as const;

export function isMekkaSupportedApiPath(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return true;
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) return false;
  if (BLOCKED_API_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
    return false;
  return !BLOCKED_API_SEGMENTS.some((segment) => pathname.includes(segment));
}
