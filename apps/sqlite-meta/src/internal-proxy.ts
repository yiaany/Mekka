import { timingSafeEqual } from "node:crypto";

export const internalProxyTokenError =
  "MEKKA_INTERNAL_PROXY_TOKEN must contain at least 24 visible ASCII characters without whitespace.";

export function readInternalProxyToken(value: string | undefined, required: boolean): string {
  if (value === undefined) {
    if (required) throw new Error(internalProxyTokenError);
    return "";
  }
  if (value.length < 24 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new Error(internalProxyTokenError);
  }
  return value;
}

export function isInternalProxyRequest(
  request: Request,
  token: string,
  allowMissingToken: boolean,
): boolean {
  if (token.length === 0) return allowMissingToken;
  const provided = request.headers.get("x-mekka-internal-proxy") ?? "";
  if (provided.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}
