import { createTursoBranchAdapter } from "@mekka/turso-branch";
import type { SqliteMetaPreviewDependencies } from "./previews";

/**
 * Previews are optional only when every provider variable is absent. A partial
 * configuration fails closed so deployment mistakes cannot silently disable previews.
 */
export function openPreviewDependencies(
  env: Readonly<Record<string, string | undefined>>,
  isLocalDevelopment: boolean,
): SqliteMetaPreviewDependencies {
  const required = [
    "MEKKA_TURSO_ORGANIZATION",
    "MEKKA_TURSO_GROUP",
    "MEKKA_TURSO_SOURCE_DATABASE",
    "MEKKA_TURSO_API_TOKEN",
  ];
  const configured = required.filter((name) => (env[name]?.trim().length ?? 0) > 0);
  if (configured.length === 0) return Object.freeze({ adapter: null });
  if (configured.length !== required.length) {
    throw new Error("Turso previews require all MEKKA_TURSO_* provider variables together.");
  }

  const requestTimeoutRaw = env.MEKKA_TURSO_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs =
    requestTimeoutRaw === undefined || requestTimeoutRaw.trim().length === 0
      ? undefined
      : Number(requestTimeoutRaw);
  if (
    requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000)
  ) {
    throw new Error("MEKKA_TURSO_REQUEST_TIMEOUT_MS must be an integer between 1 and 60000.");
  }
  const adapter = createTursoBranchAdapter({
    organization: env.MEKKA_TURSO_ORGANIZATION as string,
    group: env.MEKKA_TURSO_GROUP as string,
    sourceDatabase: env.MEKKA_TURSO_SOURCE_DATABASE as string,
    apiTokenReference: "MEKKA_TURSO_API_TOKEN",
    ...(env.MEKKA_TURSO_BASE_URL?.trim() ? { baseUrl: env.MEKKA_TURSO_BASE_URL.trim() } : {}),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    allowLocalhost: isLocalDevelopment && env.MEKKA_TURSO_ALLOW_LOCALHOST === "1",
  });
  return Object.freeze({ adapter });
}
