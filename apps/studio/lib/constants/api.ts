const PUBLIC_URL = new URL(
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- deployment runtime configuration
  process.env.MEKKA_PUBLIC_URL ||
    process.env.SUPABASE_PUBLIC_URL ||
    "http://localhost:8000",
);

// Use LOGFLARE_URL until analytics/v1/ routing is supported
export const PROJECT_ANALYTICS_URL = process.env.LOGFLARE_URL
  ? `${process.env.LOGFLARE_URL}/api/`
  : undefined;

export const PROJECT_REST_URL = `${PUBLIC_URL.origin}/rest/v1/`;
export const PROJECT_ENDPOINT = PUBLIC_URL.host;
export const PROJECT_ENDPOINT_PROTOCOL = PUBLIC_URL.protocol.replace(":", "");
export const PROJECT_DB_HOST = PUBLIC_URL.hostname;

export const DEFAULT_PROJECT = {
  id: 1,
  ref: "local",
  name: !!process.env.CURRENT_CLI_VERSION
    ? "Mekka Studio (CLI)"
    : process.env.DEFAULT_PROJECT_NAME || "Local Project",
  organization_id: 1,
  cloud_provider: "localhost",
  status: "ACTIVE_HEALTHY",
  region: "local",
  inserted_at: "2021-08-02T06:40:40.646Z",
};
