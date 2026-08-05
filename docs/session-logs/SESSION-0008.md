# SESSION-0008: REST SELECT endpoint

## Результат
COMPLETED

## Что сделано
- Добавлено приложение `@mekka/gateway` с production-like `GET /rest/v1/{table}` и `GET /openapi.json`.
- Request path: validated tenant headers -> trusted authentication context -> tenant-to-project resolution -> rate-limit -> schema manifest -> query parser -> policy AST rewrite -> SQLite compiler -> trusted bounded executor -> JSON response.
- Полный tenant tuple из headers должен совпадать с authenticated context и resolved project. Любое несовпадение возвращает generic `403`.
- Поддержаны JSON array responses, `Range-Unit: items`, bounded `Range`, `Content-Range`, `Prefer: count=exact`, correlation trace header and safe metric callback.
- Added server caps for requested rows and serialized response bytes; query timeout is enforced by the injected executor contract.
- Добавлен exact count compiler projection without client ordering/pagination и regression test.
- Опубликована OpenAPI document и exact compatibility matrix.

## Upstream
- Использован уже approved clone `C:\Users\ilyaa\AppData\Local\Temp\opencode\postgrest-v14.16`, tag `v14.16`, commit `673bbbf291d5a3b6bda65cf5cf7c340f858a0531`; verified 3 August 2026.
- License: MIT, copyright (c) 2014 Joe Nelson and (c) 2019 Steve Chavez.
- Изучены `LICENSE`, `docs/references/api/pagination_count.rst` и `docs/references/api/resource_representation.rst` только для pagination/range/count/JSON status and header concepts.
- Haskell source, tests and protocol code are not copied or vendored; no PostgREST license or notice files are required in product tree.

## Архитектурные решения
- Authentication, rate limiting, project routing and actual statement deadline are injected server-side dependencies. Gateway does not receive or expose a database credential to the client.
- Executor accepts the compiler statement and deadline. It is the authoritative boundary that must cancel or reject timed-out database work; `RestQueryTimeoutError` maps to generic `503`.
- `count=exact` performs a second policy-rewritten `COUNT(*) AS count` query. Only exact count is supported because SQLite planned/estimated semantics are not claimed.
- Query pagination and Range headers are mutually exclusive, avoiding ambiguity. Every successful response emits `Range-Unit` and `Content-Range`.
- Metrics contain only outcome, status, duration and row count; they do not record SQL, values, actor IDs or response data.

## Измененные файлы
- `apps/gateway/src/app.ts`: REST route, full tenant binding, limits, range/count semantics, generic errors, correlation trace and metrics.
- `apps/gateway/src/openapi.ts`: OpenAPI 3.1 contract.
- `apps/gateway/test/gateway.test.ts`: HTTP integration, cross-tenant, injection, rate/row/byte cap, timeout, count/range, OpenAPI and concurrent read smoke tests.
- `apps/gateway/package.json`, `apps/gateway/tsconfig.json`: workspace application configuration.
- `apps/gateway/COMPATIBILITY.md`: exact supported PostgREST-inspired SELECT behavior and explicit exclusions.
- `packages/sqlite-compiler/src/index.ts`, `packages/sqlite-compiler/test/sqlite-compiler.test.ts`: safe `COUNT(*) AS count` compilation and regression coverage.
- `package.json`, `tsconfig.json`, `bun.lock`: gateway workspace, tests and TypeScript project integration.

## Безопасность
- Headers, auth context and project resolution all require the same full organization/project/environment/branch/generation tuple; cross-tenant routing fails closed.
- Public query passes mandatory policy rewrite before SQL compilation; no endpoint exposes direct SQL or database access.
- Parser, policy engine and compiler preserve manifest identifier allowlist and parameter binding. HTTP injection test confirms malicious filter text remains data and cannot alter schema.
- Row, response-byte and query deadline limits are applied. Client receives only stable public errors and correlation ID, never stack traces or database details.
- Response projection is constrained by policy field allowlist; policy-denied fields cannot be requested through `select`.

## Проверки
- `bun test apps/gateway/test/gateway.test.ts`: PASSED, 5 tests.
- `bun test packages/sqlite-compiler/test/sqlite-compiler.test.ts`: PASSED, 6 tests.
- `bun run typecheck`: PASSED.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `bun run check`: PASSED: format check, lint, typecheck, all tests, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Supported behavior is versioned in `apps/gateway/COMPATIBILITY.md`: root JSON array selects, existing query subset, row/field policy enforcement, bounded Range, `Content-Range`, `Range-Unit`, and `Prefer: count=exact`.
- Unsupported: `count=planned`, `count=estimated`, CSV, singular object media type, null stripping, embedding, RPC, mutations and anonymous policy editing.
- HTTP statuses intentionally remain product public-error semantics for policy, quota and infrastructure errors rather than claiming byte-for-byte PostgREST error-body compatibility.

## Ограничения и риски
- The gateway is a composable app factory, not a deployment runtime. A production host must provide validated authentication, per-tenant project routing, durable distributed rate limiter and database executor with actual cancellation support.
- `count=exact` runs a second statement and may be expensive; future quota/metering should charge it separately.
- Response-byte limit currently measures serialized JSON after fetch, so a single oversized row can still be read into server memory before the `413` response. Dedicated storage execution limits or incremental serialization are needed for stronger memory containment.
- No audit persistence or OpenTelemetry exporter is wired yet; current metric callback and correlation header are the trace/metric integration point.

## Следующая рекомендуемая сессия
- `SESSION-0009`: REST mutations with idempotency, same-transaction old/new policy checks, optimistic concurrency and audit events.
