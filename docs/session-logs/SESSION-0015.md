# SESSION-0015: Studio Table Editor

## Результат
COMPLETED

## Что сделано
- SQLite Table Editor в Studio теперь создает таблицы, переименовывает и удаляет таблицы, а также добавляет supported columns без перезагрузки страницы.
- Для каждого mutation UI показывает generated migration SQL; destructive `DROP TABLE` требует явного confirmation checkbox.
- Studio Domain SDK получил typed table definition и mutation contracts. Unsupported PostgreSQL types/options не являются частью SDK payload и отклоняются до network request.
- SDK и `sqlite-meta` возвращают migration diff и checkpoint ID; stale `expectedSchemaHash` становится `conflict`, а UI предлагает reload schema flow.
- Same-origin Studio proxy расширен только на allowlisted table/column paths, methods и idempotency key; arbitrary provider paths не проксируются.

## Upstream
- Studio: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, annotated tag object `a26446c913d2aff2beedbc0d181a42c13da161b7`, resolved commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, Apache-2.0. Клон проверен 4 августа 2026; LICENSE сохранен в `apps/studio/UPSTREAM_LICENSE`.
- postgres-meta: `https://github.com/supabase/postgres-meta`, commit `e7d86a395ac9593a36182fc2a22b312a54516578`, Apache-2.0. Изучены table/column management contracts как reference; PostgreSQL catalog queries и DDL compiler не переносились.
- Новый UI и SQLite contracts являются Mekka code; upstream source code в этот slice не копировался.

## Архитектурные решения
- `sqlite-meta` остается единственной persistence/DDL boundary: Studio получает typed resource DTO и migration SQL, но не PRAGMA rows, arbitrary SQL или service credentials.
- UI создает idempotency key на каждую mutation. Proxy требует ключ для non-GET и forwards only allowlisted identity/auth headers.
- SQLite identity использует validated table name, не PostgreSQL relation OID. Row grid, foreign-key visual editor и raw SQL намеренно не подключены.

## Измененные файлы
- `packages/studio-domain-sdk/src/index.ts`: typed table/column CRUD client, validation и mutation response parsing.
- `packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: mutation diff and client-side injection regression coverage.
- `apps/sqlite-meta/src/app.ts`: table detail read route и mutation envelope with generated SQL/checkpoint ID.
- `apps/sqlite-meta/test/sqlite-meta.test.ts`: updated mutation envelope assertions.
- `apps/studio/pages/api/platform/sqlite-meta/[ref]/[...path].ts`: method/path/idempotency allowlist for schema mutations.
- `apps/studio/components/interfaces/SqliteTableEditor/SqliteTableEditor.tsx`: supported SQLite table editor UI, previews and destructive confirmation.
- `apps/studio/components/layouts/TableEditorLayout/*`, `apps/studio/pages/project/[ref]/editor/*`: navigation and creation routing for SQLite tables.

## Безопасность
- Full tenant tuple remains forwarded and verified; project ref mismatch fails closed.
- Identifiers, schema hashes, column types, column count and idempotency key are validated in the SDK and again in `sqlite-meta`.
- No hidden unsupported column options are serialized; only `INTEGER`, `TEXT`, `REAL`, `BLOB`, `NUMERIC`, nullable and create-time primary key are representable.
- Destructive delete requires explicit UI confirmation and backend checkpoint before DDL.
- Proxy cannot forward arbitrary paths/methods, cookies or service credentials.

## Проверки
- `bun test apps/sqlite-meta/test/sqlite-meta.test.ts packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: PASSED, 15 tests.
- `bun run typecheck`: PASSED.
- `bun run --cwd apps/studio typecheck`: PASSED.
- `bunx biome format --write <changed files>`: PASSED.

## Совместимость
- Preserved: pinned Studio Table Editor shell/navigation and schema list contract.
- Supported SQLite subset: table create/rename/delete, add nullable column, column/table list/detail and generated migration diff.
- Unsupported: PostgreSQL schemas/roles/extensions, default expressions, foreign keys, indexes UI, NOT NULL additive columns, row grid, raw SQL and visual foreign-key editor.

## Ограничения и риски
- A deployed authenticated Studio-to-backend browser e2e environment is not present in the workspace; typed service integration and Studio typecheck cover the boundary locally.
- Table rename/add-column previews are generated from supported UI state; backend returned migration SQL remains authoritative after apply.

## Следующая рекомендуемая сессия
- `SESSION-0016`: add constrained row grid and SQL editor paths through the Studio Domain SDK without exposing arbitrary SQL.
