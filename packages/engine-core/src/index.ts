export * from "./libsql";
export * from "./sqlite";

export type EngineKind = "libsql-remote" | "sqlite";

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

export interface EngineExecutor {
  execute<Row extends Record<string, EngineValue> = Record<string, EngineValue>>(
    statement: EngineStatement,
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
  | "ENGINE_AUTH"
  | "ENGINE_TIMEOUT"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_CONFLICT"
  | "ENGINE_UNSUPPORTED"
  | "ENGINE_FAILED";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  override readonly cause: unknown;

  constructor(code: EngineErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
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
