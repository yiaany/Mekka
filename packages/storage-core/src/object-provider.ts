export type ObjectProviderErrorCode =
  | "OBJECT_PROVIDER_INVALID"
  | "OBJECT_PROVIDER_CONFLICT"
  | "OBJECT_PROVIDER_THROTTLED"
  | "OBJECT_PROVIDER_UNAVAILABLE";

export class ObjectProviderError extends Error {
  readonly code: ObjectProviderErrorCode;
  readonly retryable: boolean;

  constructor(code: ObjectProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ObjectProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ObjectProviderMetadata = Readonly<{
  key: string;
  size: number;
  checksumSha256: string;
  etag: string | null;
}>;

export type ObjectProviderPutRequest = Readonly<{
  key: string;
  body: Uint8Array;
  contentType: string;
  checksumSha256: string;
  idempotencyKey: string;
}>;

export type ObjectProviderGetResult = Readonly<{
  metadata: ObjectProviderMetadata;
  body: Uint8Array;
}>;

export interface ObjectProvider {
  put(request: ObjectProviderPutRequest): Promise<ObjectProviderMetadata>;
  get(key: string, maxBytes: number): Promise<ObjectProviderGetResult | null>;
  head(key: string): Promise<ObjectProviderMetadata | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly ObjectProviderMetadata[]>;
  close(): void;
}
