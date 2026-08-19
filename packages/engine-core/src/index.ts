export * from "./libsql";
export * from "./replica";
export * from "./sqlite";

export type EngineKind = "libsql-remote" | "libsql-replica" | "sqlite";

export type EngineDialect = "sqlite";

export type EngineCapabilities = Readonly<{
  transactions: boolean;
  dialect: EngineDialect;
  remote: boolean;
}>;

export type EngineValue = string | number | bigint | Uint8Array | null;

export type EngineStatement = Readonly<{
  sql: string;
  parameters?: readonly EngineValue[];
}>;

export type EngineResult<Row extends Record<string, EngineValue> = Record<string, EngineValue>> =
  Readonly<{
    rows: readonly Row[];
    changes: number;
    lastInsertRowid: number | bigint;
  }>;

/**
 * Safe outcome classification of a single engine operation:
 * - `ok`: the operation succeeded.
 * - `failed`: the operation was definitely not applied (rejected before send or by the server).
 * - `unknown`: the operation may have been applied. A mutation with this outcome must never be
 *   retried automatically; the caller retries manually using the operation id.
 */
export type EngineOutcome = "ok" | "failed" | "unknown";

export type EngineExecuteOptions = Readonly<{
  /**
   * Caller-supplied operation id used to correlate an operation across a manual retry. The
   * engine uses it purely for correlation and never deduplicates by it; there is no durable
   * idempotency ledger.
   */
  operationId?: string;
}>;

export interface EngineExecutor {
  execute<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
    options?: EngineExecuteOptions,
  ): Promise<EngineResult<Row>>;
}

export interface Engine extends EngineExecutor {
  readonly engineKind: EngineKind;
  readonly capabilities: EngineCapabilities;
  transaction<T>(callback: (transaction: EngineExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type EngineErrorCode =
  | "ENGINE_CLOSED"
  | "ENGINE_CAPABILITY_UNSUPPORTED"
  | "ENGINE_STATEMENT_FORBIDDEN"
  | "ENGINE_BUSY"
  | "ENGINE_RATE_LIMITED"
  | "ENGINE_AUTH"
  | "ENGINE_TIMEOUT"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_CONFLICT"
  | "ENGINE_NOT_FOUND"
  | "ENGINE_UNSUPPORTED"
  | "ENGINE_FAILED";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  /** Whether the operation was definitely not applied (`failed`) or may have been applied (`unknown`). */
  readonly outcome: EngineOutcome;
  /** Operation id for correlation and safe manual retry, when one was assigned. */
  readonly operationId: string | null;
  override readonly cause: unknown;

  constructor(
    code: EngineErrorCode,
    message: string,
    cause?: unknown,
    outcome: EngineOutcome = "failed",
    operationId: string | null = null,
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.outcome = outcome;
    this.operationId = operationId;
    this.cause = cause;
  }
}

export function requireCapability(
  engine: Pick<Engine, "capabilities">,
  capability: "transactions" | "remote",
): void {
  if (engine.capabilities[capability] !== true) {
    throw new EngineError(
      "ENGINE_CAPABILITY_UNSUPPORTED",
      `Engine does not support capability "${capability}".`,
    );
  }
}
