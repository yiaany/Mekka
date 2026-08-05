# SESSION-0011: sqlite-meta management API

## Результат
COMPLETED

## Что сделано
- Добавлено приложение `@mekka/sqlite-meta` с Studio-facing HTTP resources: `GET/POST/PATCH/DELETE /tables`, `GET/POST/PATCH /columns` и `GET/POST /indexes`.
- Публичные DTO построены из `SchemaManifest`: table name, columns, primary key и created indexes. Raw `PRAGMA` rows, SQLite internal tables и DDL text не раскрываются.
- Каждая management mutation строит hash-addressed migration artifact и применяет ее через `@mekka/migration-engine`; schema cache invalidates после apply.
- Supported subset: create table, rename table, delete table, add nullable column, rename column, create ordinary/unique index.
- Table creation supports only `INTEGER`, `TEXT`, `REAL`, `BLOB` and `NUMERIC`; primary keys are defined only during table creation.
- Destructive table delete creates a SQLite checkpoint before `DROP TABLE` and passes it into migration apply.
- Schema changes require current `expectedSchemaHash`, tenant-scoped `schema:manage` capability and an `Idempotency-Key`.
- Added audit callback carrying action, actor, migration hash and checkpoint ID.

## Upstream
- Cloned `https://github.com/supabase/postgres-meta.git` into `C:\Users\ilyaa\AppData\Local\Temp\opencode\postgres-meta`, commit `e7d86a395ac9593a36182fc2a22b312a54516578`; verified 3 August 2026.
- License: Apache-2.0. Relevant materials inspected: `README.md`, `src/server/routes/tables.ts`, `columns.ts`, `indexes.ts`, and table/column/index contract tests.
- Adapted only resource organization and stable DTO/testing concepts. PostgreSQL catalog SQL, Fastify schemas, PostgreSQL DDL generator, raw query endpoint, branding and source code were not copied or vendored; no upstream attribution file is required in the product tree.

## Архитектурные решения
- The API uses table/column names rather than PostgreSQL numeric catalog IDs because SQLite has no stable relation OID model.
- `expectedSchemaHash` is a mandatory optimistic-concurrency precondition. The migration engine rejects stale targets before DDL executes.
- Identifier, type and index-column validation happen before artifact construction. The API never accepts arbitrary SQL or PostgreSQL options.
- Destructive `DROP TABLE` is admitted by the constrained migration engine only with a checkpoint made from the current schema. No in-place restore or active database file copy is introduced.

## Измененные файлы
- `apps/sqlite-meta/src/app.ts`: management routes, DTO mapping, authorization, artifact creation, checkpointing and audit integration.
- `apps/sqlite-meta/test/sqlite-meta.test.ts`: HTTP contract, integration, stale update, tenant/capability, checkpoint and injection tests.
- `apps/sqlite-meta/{package.json,tsconfig.json,COMPATIBILITY.md}`: workspace configuration and explicit behavior matrix.
- `packages/migration-engine/src/index.ts`: allowlisted SQLite table/column rename and destructive table/index operations with required checkpoint.
- `packages/migration-engine/README.md`: updated migration subset documentation.
- `package.json`, `tsconfig.json`, `bun.lock`: sqlite-meta workspace, test command and TypeScript project references.

## Безопасность
- Authentication is evaluated before tenant/capability authorization. Full tenant tuple in headers must equal authenticated and resolved project tenant.
- Schema writes require a non-expired tenant-bound `schema:manage` capability, a valid idempotency key and current schema hash.
- User-supplied identifiers are strict allowlisted names; types are finite allowlisted SQLite affinities; all other PostgreSQL options return explicit validation/unsupported errors.
- Arbitrary SQL, triggers, views, virtual tables, generated columns, extensions and raw PRAGMA remain unavailable.
- Table deletion creates a checkpoint before DDL, and the migration ledger captures actor/idempotency/hash. HTTP tests cover cross-tenant routing and injection-shaped identifiers.

## Проверки
- `bun test apps/sqlite-meta/test/sqlite-meta.test.ts`: PASSED, 3 tests.
- `bun test packages/migration-engine/test/migration-engine.test.ts`: PASSED, 4 tests.
- `bun run typecheck`: PASSED.
- `bun run check`: PASSED: format check, lint, typecheck, full test suite, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Supported SQLite Meta subset is documented in `apps/sqlite-meta/COMPATIBILITY.md`.
- Intentional deviations from postgres-meta: no `pg` connection header, PostgreSQL IDs/schemas/RLS/types/comments/roles/extensions/functions, raw query API or PostgreSQL DDL semantics.
- Unsupported table rebuilds include drop column, changing column type/default/nullability and modifying an existing primary key.

## Ограничения и риски
- The current API returns the pre-delete DTO for successful table deletion; recovery metadata is emitted through the audit callback and checkpoint artifact is not yet persisted in a control-plane catalog.
- Idempotent retry of a destructive request after the table has been dropped is not yet replayable through this HTTP layer because target lookup occurs before ledger replay. This should be resolved when migration artifact storage becomes a first-class control-plane resource.
- No HTTP deployment host, rate limiter, durable audit store, backup object store or restore approval workflow is wired in this session.
- Index deletion and table deletion are backend-supported constrained migration operations; the Studio-facing endpoint exposes only table deletion in this slice.

## Следующая рекомендуемая сессия
- `SESSION-0012`: private Studio fork consuming these sqlite-meta DTOs and generated migration/checkpoint workflow.
