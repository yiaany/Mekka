# SESSION-0016: Row grid и SQL Editor

## Результат
PARTIAL

## Что сделано
- Добавлен SQLite row grid в Table Editor: server-side pagination до 200 строк, фильтрация по primary key, создание, редактирование JSON-значений и удаление строки.
- Studio Domain SDK получил typed row CRUD и SQL execution contracts; provider-specific DTO не передаются в Studio.
- Добавлен constrained SQLite SQL Editor для нового SQL snippet: `SELECT` является default, write-flow требует явного UI opt-in и backend capability `sql:execute`.
- SQL history показывает только время, режим и статус. SQL text и query results в history/audit не сохраняются.
- Добавлены cancellation из Studio через `AbortSignal` и client timeout 10 секунд.

## Upstream
- Studio: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, annotated tag object `a26446c913d2aff2beedbc0d181a42c13da161b7`, resolved commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, Apache-2.0. Проверено 4 августа 2026; LICENSE сохранен в `apps/studio/UPSTREAM_LICENSE`.
- postgres-meta: reference commit `e7d86a395ac9593a36182fc2a22b312a54516578`, Apache-2.0. Изучены rows/SQL contracts как reference; PostgreSQL query implementation не переносилась.
- Upstream source code в этот slice не копировался; использована существующая pinned Studio navigation и создан Mekka adapter UI.

## Архитектурные решения
- Row grid обращается только через same-origin proxy и `Studio Domain SDK`; service credentials в браузер не передаются.
- Row identifiers и фильтр проверяются against current schema manifest. Row values передаются как parameters, не конкатенируются в SQL.
- SQL endpoint допускает одну `SELECT`, `INSERT`, `UPDATE` или `DELETE`; read requires `data:read`, write requires short-lived `sql:execute`. `UPDATE`/`DELETE` требуют `WHERE`.
- SQL endpoint требует `LIMIT <= 200` для `SELECT`, запрещает DDL, PRAGMA, transaction control, `ATTACH`, virtual tables, system tables и table names вне manifest.

## Измененные файлы
- `apps/sqlite-meta/src/app.ts`: rows CRUD, constrained SQL execution, limits, capability checks и metadata-only audit.
- `packages/studio-domain-sdk/src/index.ts`: typed rows/SQL client, validation, cancellation и response parsing.
- `apps/studio/pages/api/platform/sqlite-meta/[ref]/[...path].ts`: allowlisted rows/SQL proxy routes.
- `apps/studio/components/interfaces/SqliteTableEditor/*`: paginated row grid и constrained SQL UI.
- `apps/studio/pages/project/[ref]/sql/[id].tsx`: SQLite SQL surface for a new snippet.
- `apps/sqlite-meta/COMPATIBILITY.md`: documented rows and SQL subset.
- `apps/sqlite-meta/test/sqlite-meta.test.ts`, `packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: regression coverage.

## Безопасность
- Проверены полный tenant tuple, `data:read`/`data:write`/`sql:execute` capabilities, cross-tenant denial и server-side service credential boundary.
- Предотвращены multi-statement execution, dangerous SQLite commands, system-table access, unknown table access, identifier injection, unbounded reads и SQL/row-result retention in audit/history.
- Audit records only statement SHA-256 and affected row count; query SQL and returned data are not written to audit events.

## Проверки
- `bun test apps/sqlite-meta/test/sqlite-meta.test.ts packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: PASSED, 18 tests.
- `bun run typecheck`: PASSED.
- `bun run --cwd apps/studio typecheck`: PASSED.

## Совместимость
- Supported: SQLite tables from manifest, bounded pagination/filtering, primitive row values, constrained single-statement administrative SQL.
- Deliberate deviations: no PostgreSQL planner/explain, functions, schemas, system catalog, multi-statement batches, arbitrary DDL, binary/JSON row editing or persisted SQL text history.

## Ограничения и риски
- Server cancellation reaches the proxy and SDK, but the current synchronous `StorageAdapter` has no SQLite interrupt primitive; an in-flight database statement cannot be forcibly interrupted until storage-core receives a cancellable execution boundary.
- Browser e2e against a provisioned authenticated Studio/backend deployment is unavailable in this workspace. In-process service/SDK contracts and Studio typecheck were run instead.
- Full production SQL page still uses the upstream snippet route for existing saved snippets; this slice overrides the new-query path only to avoid silently changing persisted upstream snippet behavior.

## Следующая рекомендуемая сессия
- Add a cancellable storage execution primitive and authenticated browser e2e smoke for row CRUD and constrained SQL.
