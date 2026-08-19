import { EngineError } from "@mekka/engine-core";
import { MigrationError } from "@mekka/migration-engine";
import { type ErrorCode, ProtocolError } from "@mekka/protocol";

export class MetaError extends Error {
  constructor(
    readonly code: ErrorCode,
    override readonly message: string,
  ) {
    super(message);
    this.name = "MetaError";
  }

  get status(): number {
    switch (this.code) {
      case "auth":
        return 401;
      case "forbidden":
        return 403;
      case "conflict":
        return 409;
      case "quota":
        return 429;
      case "unsupported":
        return 501;
      case "not_found":
        return 404;
      case "infrastructure":
        return 503;
      case "validation":
        return 400;
    }
    return 503;
  }
}

/**
 * Maps application errors to typed client-facing errors. Never includes error
 * causes, stack traces or provider internals in the resulting message.
 */
export function toMetaError(error: unknown): MetaError {
  if (error instanceof MetaError) {
    return error;
  }
  if (error instanceof MigrationError) {
    switch (error.code) {
      case "MIGRATION_CONFLICT":
        return new MetaError("conflict", error.message);
      case "MIGRATION_FORBIDDEN":
        return new MetaError("forbidden", error.message);
      case "MIGRATION_VALIDATION":
        return new MetaError("validation", error.message);
      case "MIGRATION_INFRASTRUCTURE":
        return new MetaError("infrastructure", error.message);
    }
  }
  if (error instanceof EngineError) {
    switch (error.code) {
      case "ENGINE_CONFLICT":
        return new MetaError(
          "conflict",
          "The database rejected the operation because of a conflict.",
        );
      case "ENGINE_NOT_FOUND":
        return new MetaError("not_found", "The requested database resource does not exist.");
      case "ENGINE_RATE_LIMITED":
        return new MetaError("quota", "The database is rate limiting requests; retry later.");
      case "ENGINE_CAPABILITY_UNSUPPORTED":
      case "ENGINE_STATEMENT_FORBIDDEN":
      case "ENGINE_UNSUPPORTED":
        return new MetaError(
          "unsupported",
          "The selected database engine does not support this operation.",
        );
      default:
        return new MetaError("infrastructure", "The selected database engine is unavailable.");
    }
  }
  if (error instanceof ProtocolError) {
    return new MetaError(error.code, error.message);
  }
  return new MetaError("infrastructure", "SQLite meta operation failed.");
}
