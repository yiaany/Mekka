# SESSION-0013: Studio Domain SDK

## Результат
PARTIAL

## Что сделано
- Создан `@mekka/studio-domain-sdk` с typed operations `listTables` и `getSchemaHealth`.
- SDK валидирует SQLite Meta responses, ограничивает размер response до 2 MiB, не раскрывает raw provider DTO и возвращает typed `StudioDomainError` с public error code, HTTP status и correlation ID.
- Каждая SDK request отправляет полный tenant tuple и принимает только session token или publishable key; service-role credentials не поддерживаются.
- SDK передает caller-owned `AbortSignal` в `fetch` и не превращает cancellation в infrastructure error.
- В `sqlite-meta` добавлен `GET /schema/health` с manifest format, SQLite schema version и current schema hash.
- Schema read endpoints требуют `schema:read` либо `schema:manage`; schema mutations по-прежнему требуют только `schema:manage`.
- Primary Table Editor list path больше не генерирует PostgreSQL catalog SQL: `entity-types-infinite-query` использует Studio Domain SDK через same-origin allowlisted proxy к `sqlite-meta`.
- SQLite table list render использует domain summary и read-only list item. Синтетический negative numeric key локален для совместимости pinned list contract и не используется для navigation/detail API; SQLite table editor остается scope SESSION-0015.
- Added explicit Studio UI states for expired session, forbidden access, schema conflict and infrastructure failure.

## Upstream
- Approved pinned fork: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, annotated commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`; tag was re-verified on 4 August 2026 with `git ls-remote`.
- License: Apache-2.0; retained in `apps/studio/UPSTREAM_LICENSE`. Upstream `NOTICE` is absent at the pinned commit.
- A new clone was not required because the approved fork commit did not change. Relevant inspected scope: `data/entity-types/entity-types-infinite-query.ts`, `TableEditorMenu`, prefetch path, fetcher/error conventions and existing fork tests.
- No upstream source was copied. The new SDK, proxy, DTO mapping and SQLite-specific display components are Mekka code.

## Архитектурные решения
- Browser requests same-origin `/api/platform/sqlite-meta/:ref/{tables|schema/health}` only. The proxy allowlists paths, verifies URL project ref equals `x-mekka-project-id`, forwards only session/publishable and tenant headers, never forwards cookies or service credentials, and aborts upstream fetch when the client disconnects.
- `sqlite-meta` remains the provider boundary. Components receive only the adapted list entity fields; PRAGMA rows, DDL, columns and indexes remain outside React components.
- Domain SDK validates provider payloads instead of importing types from `apps/sqlite-meta`, preserving a stable package boundary.
- SQLite has name identity rather than PostgreSQL relation OIDs. This session deliberately does not manufacture a stable numeric table ID or invoke PostgreSQL-only detail, rows, lints, privileges or export paths.

## Измененные файлы
- `packages/studio-domain-sdk/*`: typed client, errors, cancellation, contract tests and SDK documentation.
- `apps/sqlite-meta/src/app.ts`: schema health and split read/manage capability checks.
- `apps/sqlite-meta/test/sqlite-meta.test.ts`: schema-health, read-only access and SDK-to-service integration coverage.
- `apps/sqlite-meta/COMPATIBILITY.md`: documented schema health/read authorization.
- `apps/studio/data/{studio-domain,entity-types}/*`: SDK bootstrap and pinned entity-list compatibility mapping.
- `apps/studio/pages/api/platform/sqlite-meta/[ref]/[...path].ts`: constrained Studio backend proxy.
- `apps/studio/components/layouts/TableEditorLayout/*`: SQLite list display and explicit domain-error panel.
- `apps/studio/{.env.example,turbo.jsonc,package.json}`: safe public routing configuration and workspace wiring.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace/project/test wiring.

## Безопасность
- Full tenant identity and generation are validated by the SDK and bound by `sqlite-meta`; proxy fails closed on project header/path mismatch.
- Browser path has no service-role fallback and proxy does not relay cookies or arbitrary client headers.
- SDK only emits public, stable error messages; malformed/non-JSON/provider responses become redacted `infrastructure` errors.
- Request cancellation is propagated instead of being misreported as a service outage.
- Schema inspection is least-privilege (`schema:read`); mutation access remains `schema:manage`.
- Provider response shape, list size and response bytes are bounded before data reaches Studio.

## Проверки
- `bun install --ignore-scripts`: PASSED.
- `bun test apps/sqlite-meta/test/sqlite-meta.test.ts packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: PASSED, 13 tests.
- `bun run test:studio:fork`: PASSED.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `bun run lint:studio`: PASSED with 2168 existing upstream warnings and zero errors.
- `bun run typecheck`: PASSED.
- `bun run typecheck:studio`: PASSED.
- `bun run check`: PASSED, including format, root lint, root typecheck, 64 tests, root build and health smoke.
- `git diff --check`: PASSED.
- `node node_modules\\next\\dist\\bin\\next build` in `apps/studio`: PARTIAL. Next compiled successfully in 9.5 minutes, then the execution host stopped the process while collecting page data after the 15-minute timeout.

## Совместимость
- Existing upstream Table Editor shell, query keys, filters, sorting, pagination, loading and empty states are preserved.
- Deliberate deviation: only SQLite tables are listed in namespace `main`; PostgreSQL schemas, views, materialized/foreign/partitioned tables, RLS and relation OIDs are not represented.
- `GET /schema/health` is a Mekka contract, not postgres-meta compatibility.

## Ограничения и риски
- The final Studio production build did not complete because the host timeout stopped Next during page-data collection. The compile phase completed successfully; no completed build artifact claim is made.
- No live deployment host was available to run an end-to-end browser request against a configured `STUDIO_BACKEND_API_URL`; service-to-SDK integration and Studio mapping tests cover the boundary in-process.
- Table navigation, row editor, table mutations, lints, privileges and exports remain PostgreSQL-oriented and intentionally disabled for SDK-origin list items. They require the SQLite Table Editor vertical slice.
- Public routing identity defaults in `.env.example` are local development values only. Production must inject tenant routing configuration and backend authentication must bind it to the session.

## Следующая рекомендуемая сессия
- `SESSION-0014`: replace the remaining local tenant bootstrap defaults with authenticated control-plane project metadata, then run a fully provisioned Studio-to-sqlite-meta browser smoke.
