# Studio Domain SDK

Typed browser-safe boundary between Mekka Studio and Studio backend services.

The SDK exposes schema/table/row operations plus dedicated Auth and Storage clients. Every request carries the complete tenant tuple. Administrative clients are session-only, require a caller-provided CSRF token for the same-origin proxy, and never return service-role or object-provider credentials. Provider DTOs are parsed at the boundary, so consumers receive stable Studio domain objects rather than raw SQLite, Better Auth, or provider records.

`createStudioStorageClient` supports bucket list/create/settings/delete, bounded object listing, standard and fixed-length sequential resumable uploads, short-lived signed downloads, object deletion, and read-only effective policy summaries. Large uploads report progress, recover the authoritative offset with `HEAD`, and retry interrupted chunks without exposing data-plane credentials to browser code.

Cancellation is caller-owned through `AbortSignal`. Aborted requests are not converted into infrastructure failures.
