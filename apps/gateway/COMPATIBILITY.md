# REST Data API Compatibility Matrix

The versioned `supabase-js` compatibility tuple and measured client contract are documented in `SUPABASE_DATA_COMPATIBILITY.md`.

| Behavior | Status | Notes |
| --- | --- | --- |
| `GET /rest/v1/{table}` JSON array | Supported | Requires authenticated tenant context and matching full tenant headers. |
| `select`, simple filters, boolean groups, order, limit, offset | Supported | Bounded subset defined by `@mekka/query-ast`. |
| Row policies and field allowlist | Supported | Mandatory deny-by-default `select` policy before SQL compilation. |
| `Range-Unit: items`, `Range: start-end` | Supported | Cannot combine with query pagination; bounded by server row cap. |
| `Content-Range`, `Range-Unit` | Supported | Always emitted; empty result uses `*/total`. |
| `Prefer: count=exact` | Supported | Performs a second policy-rewritten count query and returns HTTP 206. |
| `count=planned`, `count=estimated` | Unsupported | SQLite statistics semantics are not claimed. |
| CSV, singular object, null stripping | Unsupported | JSON array only. |
| `POST /rest/v1/{table}` insert | Supported | Native requests require caller idempotency. Configured `supabase-js` compatibility requests receive a per-request internal key. |
| `PATCH /rest/v1/{table}` and `DELETE /rest/v1/{table}` | Supported | Query filters select affected rows; unbounded writes require `data:bulk`. |
| `Prefer: return=minimal` | Supported | Default write mode; returns `204` and `Preference-Applied`. |
| `Prefer: return=representation` | Supported | Returns policy-filtered JSON array; requires a permitted `select` policy. |
| `Prefer: resolution=merge-duplicates` | Supported | Primary-key upsert. Conflict targets other than the complete primary key are rejected explicitly. |
| JSON array writes | Supported with capability | Explicit `data:bulk` capability, bounded by the server mutation row cap and executed atomically. |
| Non-primary `on_conflict`, `resolution=ignore-duplicates`, `return=headers-only`, `missing=default` | Unsupported | Explicit product error; no alternate semantics. |
| Embedding and RPC | Unsupported | Deferred to later sessions. |

## Object Storage HTTP Subset

| Behavior | Status | Notes |
| --- | --- | --- |
| Authenticated object `PUT`, `GET`, `DELETE` | Supported | Full tenant headers, Bearer authentication, exact tenant binding, rate limit and storage-core policy are mandatory. Gateway never accesses an object provider directly. |
| Raw bounded uploads | Supported | Default cap is 10 MB. `Content-Length` is checked before reading and the stream reader independently enforces the cap. `Idempotency-Key` is mandatory. |
| Object path limits | Supported | Standard and resumable object inputs allow at most 180 UTF-8 bytes per logical segment and 384 UTF-8 bytes for the complete logical path. Oversized paths return HTTP 400 before metadata reservation or provider access. |
| Client SHA-256 | Supported | Optional `X-Mekka-Content-SHA256` must be exact lowercase 64-character hex and is compared in constant time. |
| MIME validation | Supported subset | `application/octet-stream`; UTF-8, NUL-free `text/plain` with optional `charset=utf-8`; valid `application/json`; PNG, JPEG and PDF magic. Declared concrete MIME must match bytes. |
| Authenticated conditional reads | Supported | Policy-authorized metadata is checked before provider reads, so matching `If-None-Match` returns `304` without downloading the object. Responses retain quoted checksum ETag, safe attachment disposition, `nosniff`, exact length and `private, must-revalidate`. |
| Signed object reads | Supported | Signing is policy-authorized. URL origin is configured, never derived from `Host`. The token and complete tenant tuple are query parameters. `GatewayDependencies.consumeSignedRateLimit(request)` supports global/IP limiting and runs before tenant query parsing and project resolution. Invalid, expired or incorrectly bound grants return generic `403 forbidden`. |
| Signed caching | Supported | Exact grant and object-version metadata validation permits `304` before provider reads. Responses use `public, max-age=<remaining seconds>, immutable`; the token remains in the query cache key. |
| TUS-inspired resumable upload | Supported subset | Sequential fixed-length upload with `Tus-Resumable: 1.0.0`, strict base64 `contentType` metadata and `application/octet-stream` only. Default expiry is 24 hours and chunk cap is 1 MB. |
| Resumable `HEAD`, `PATCH`, `DELETE` | Supported | Exact offsets, actor and tenant ownership, bounded chunks, final object identity headers, idempotent HTTP abort and opportunistic expiry cleanup. |
| Resumable create retry | Supported | Repeating the same tenant/actor/idempotency/target/length/content-type request returns the original upload session even when the transport recomputes expiry. |
| Deferred length, concatenation, parallel upload | Unsupported | This gateway does not claim full TUS compatibility. |
| Creation-with-upload | Unsupported | Creation requests do not accept an initial object chunk. |
| Bucket list/get/create/update/delete | Supported admin subset | Mutations require tenant-bound `storage:admin`, storage policy authorization and idempotency. Bucket operations are audited. Only the existing `isPublic` metadata field can be updated; anonymous public delivery is not exposed. |
| Object listing | Supported bounded subset | Up to 100 canonical logical objects ordered by path with optional prefix. A distinct `object:list` policy action is required; provider keys are omitted. |
| Effective policy summary | Supported read-only subset | Admin-only booleans for bucket/object actions. Policy predicates, SQL and provider details are not returned or editable. |
| Storage audit | Supported callback boundary | Bucket mutations, object create/delete and upload abort emit tenant/actor/correlation events. Object paths are SHA-256 hashed and bodies, signed tokens and provider credentials are excluded. |
| Public buckets | Unsupported | The metadata flag is retained for future compatibility, but no anonymous/public object route is implemented. Studio hides the control. |
| Range downloads, inline disposition, MIME inference, provider redirects | Out of scope | Object reads always return the complete body as a safe attachment through `ObjectStorageCore`. |
