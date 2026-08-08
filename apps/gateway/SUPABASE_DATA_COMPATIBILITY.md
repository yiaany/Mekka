# Supabase Data API compatibility

Compatibility format: `1`.

## Reference tuple

| Component | Pinned reference |
| --- | --- |
| `@supabase/supabase-js` | `2.111.0`, tag object `9a9d0ceab8cae23cba008cb50cda3775b01524cd`, commit `97b58eb428556d768ae982c511fa10c4b7b8119f` |
| `@supabase/postgrest-js` | `2.111.0`, distributed with the pinned `supabase-js` release |
| PostgREST | `v14.12`, commit `6200fbad58b99568c5124657ff43d4f6774c79fe` |
| Bun | `1.3.14` |
| SQLite | `3.53.0` |
| Verified | 6 August 2026 |

Both upstream repositories are MIT licensed. Mekka uses the published client package and adapts wire contracts only; no upstream backend source or tests are copied into the product tree.

## Authentication

Compatibility mode is enabled only when `GatewayDependencies.supabaseData` is configured and the request has an `apikey` header. `authenticateApiKey` must verify the API key/Bearer credential and return a complete tenant-bound `TenantContext`.

- Headerless URL/key requests use only the verified credential tenant.
- A complete native Mekka tenant header tuple may be supplied and must match the credential exactly.
- Partial or mismatched tenant headers fail before rate limiting, project resolution, policy evaluation or storage access.
- Native Mekka REST authentication and mandatory caller idempotency remain unchanged.

## Compatibility matrix

| `supabase-js` call | Status | Notes |
| --- | --- | --- |
| `from().select()` | Supported | JSON arrays, flat column lists and mandatory policy rewrite. |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, `not`, `or`, `match` | Supported subset | Uses `@mekka/query-ast`; values are always prepared-statement parameters. |
| `order`, `limit`, `range` | Supported | Bounded by the gateway row cap. |
| `count: exact` | Supported | Exact policy-rewritten count and `Content-Range`. Planned/estimated counts fail explicitly. |
| `insert()` | Supported | Object or uniform object array; bulk requires `data:bulk`. Compatibility requests receive a server-generated per-request idempotency key if none is supplied. |
| `update()` | Supported | Filtered update; unbounded update still requires `data:bulk`. |
| `delete()` | Supported | Filtered delete; unbounded delete still requires `data:bulk`. |
| `upsert()` | Supported subset | Complete primary key only, merge duplicates only. Primary-key-only conflict returns the existing row. |
| Mutation `.select(columns)` | Supported | Projection is checked against the select policy; denied columns fail the whole request. |
| Mutation `count: exact` | Supported | Returns `Content-Range: */N`. |
| Default/minimal return | Supported | Insert returns `201`; update/delete return `204`. |
| `onConflict` | Primary key only | Non-primary conflict targets fail explicitly; they are never silently treated as primary-key upserts. |
| `ignoreDuplicates`, `defaultToNull: false` | Unsupported | Explicit error; alternate semantics are not substituted. |
| `.single()`, CSV, null stripping, plans | Unsupported | Explicit media-type error. `maybeSingle()` client-side array coercion is not claimed as server singular parity. |
| Embedding, aliases, casts, RPC | Unsupported | Explicit parser/compatibility error. |
| `like`, `ilike`, arrays, ranges, FTS, JSON paths | Unsupported | SQLite semantics are not presented as PostgreSQL parity. |
| Boolean/JSON/blob mutation values | Unsupported | Current mutation contract accepts finite numbers, strings and null. |

## Errors and limits

Compatibility errors use the PostgREST-compatible shape:

```json
{
  "code": "MEKKA_VALIDATION",
  "details": null,
  "hint": null,
  "message": "Request validation failed."
}
```

The stable Mekka code identifies validation, auth, forbidden, conflict, quota, unsupported or infrastructure categories without exposing stack traces, SQL, secrets or PII.

The compatibility adapter does not change rate limits, policy checks, parser/compiler limits, query deadline, mutation row cap, transaction boundaries, response byte cap or tenant isolation.

## Differential harness

`apps/gateway/test/supabase-data-compat.test.ts` executes the real pinned `supabase-js` client through Gateway `fetch` and asserts the client-visible `{ data, error, count, status }` contract. The cases are deliberately limited to the supported matrix and include policy isolation, projection, exact counts, uniform bulk, rollback and explicit deviations.

A live PostgreSQL/PostgREST comparison can use the same logical cases against the pinned reference tuple. It is not part of the default local gate because the current environment has no running Docker daemon; deviations above remain explicit rather than normalized away.
