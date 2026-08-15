import { type ErrorCode, ProtocolError, type TenantContext } from "@mekka/protocol";

export const supabaseDataCompatibilityVersion = 1;

export type SupabaseDataDependencies = Readonly<{
  authenticateApiKey(request: Request): Promise<TenantContext> | TenantContext;
}>;

export type SupabaseMutationPreference = Readonly<{
  returnRepresentation: boolean;
  countExact: boolean;
  mergeDuplicates: boolean;
}>;

export function isSupabaseDataRequest(
  request: Request,
  dependencies: SupabaseDataDependencies | undefined,
): boolean {
  return dependencies !== undefined && request.headers.has("apikey");
}

export function validateSupabaseReadRequest(request: Request): void {
  validateProfile(request.headers.get("accept-profile"));
  validateJsonAccept(request.headers.get("accept"));
  parseStrictPreferences(request.headers, new Set(["count=exact"]));
}

export function parseSupabaseMutationPreference(headers: Headers): SupabaseMutationPreference {
  validateProfile(headers.get("content-profile"));
  validateJsonAccept(headers.get("accept"));
  const preferences = parseStrictPreferences(
    headers,
    new Set([
      "return=minimal",
      "return=representation",
      "resolution=merge-duplicates",
      "count=exact",
    ]),
  );
  const returns = preferences.filter((value) => value.startsWith("return="));
  const resolutions = preferences.filter((value) => value.startsWith("resolution="));
  const counts = preferences.filter((value) => value.startsWith("count="));
  if (returns.length > 1 || resolutions.length > 1 || counts.length > 1) {
    throw new ProtocolError("validation");
  }
  return Object.freeze({
    returnRepresentation: returns[0] === "return=representation",
    countExact: counts[0] === "count=exact",
    mergeDuplicates: resolutions[0] === "resolution=merge-duplicates",
  });
}

export function createSupabaseErrorBody(code: ErrorCode): Readonly<{
  code: string;
  details: null;
  hint: null;
  message: string;
}> {
  const messages: Record<ErrorCode, string> = {
    validation: "Request validation failed.",
    auth: "Authentication is required.",
    forbidden: "The requested action is not permitted.",
    conflict: "The request conflicts with the current resource state.",
    quota: "A resource quota was exceeded.",
    unsupported: "The requested operation is not supported.",
    not_found: "The requested resource does not exist.",
    infrastructure: "The service is temporarily unavailable.",
  };
  return Object.freeze({
    code: `MEKKA_${code.toUpperCase()}`,
    details: null,
    hint: null,
    message: messages[code],
  });
}

function validateProfile(profile: string | null): void {
  if (profile !== null && profile !== "public") throw new ProtocolError("unsupported");
}

function validateJsonAccept(accept: string | null): void {
  if (accept === null || accept === "*/*" || accept.includes("application/json")) return;
  throw new ProtocolError("unsupported");
}

function parseStrictPreferences(headers: Headers, allowed: ReadonlySet<string>): readonly string[] {
  const preferences = (headers.get("prefer") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (preferences.some((value) => !allowed.has(value))) throw new ProtocolError("unsupported");
  return Object.freeze(preferences);
}
