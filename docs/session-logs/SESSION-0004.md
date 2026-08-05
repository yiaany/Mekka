# SESSION-0004: Schema manifest

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/schema-manifest`, строящий versioned public manifest для SQLite tables, columns, PK, FK, indexes и unique constraints.
- Canonical JSON с фиксированным порядком полей и SQLite `schema_version` хешируется SHA-256; одинаковая схема дает одинаковый hash.
- `createSchemaManifestCache` проверяет `schema_version` перед выдачей cached manifest и автоматически пересобирает его после поддержанного DDL; также доступна явная `invalidate()` для out-of-band lifecycle.
- Введен format version `1` и явная ошибка для SQLite ниже `3.37.0`, где отсутствует `PRAGMA table_list`.
- Internal runtime tables `_mekka_*` и SQLite internal tables `sqlite_*` исключаются. Manifest не содержит SQL DDL text, data rows, secrets или иных значений приложения.
- Добавлены golden, deterministic ordering, cache invalidation, malformed catalog и unsupported-engine tests.

## Upstream
- Официальная документация SQLite: `PRAGMA table_list`, `table_xinfo`, `foreign_key_list`, `index_list`, `index_xinfo`, table-valued PRAGMA functions и `schema_version`; проверена 3 августа 2026 года. `table_list` появился в SQLite `3.37.0` 27 ноября 2021 года.
- Repository clone не требовался по Session Prompt. Код upstream не копировался и не vendor-ился.
- SQLite core распространяется как Public Domain; отдельные licensing notices в tree не добавлялись, потому что в продукт не перенесены source, documentation или tests upstream.

## Архитектурные решения
- Introspection использует fixed `SELECT` queries к read-only table-valued PRAGMA functions, а table/index names передаются исключительно bound parameters. Это сохраняет запрет StorageAdapter на caller-controlled `PRAGMA` и не смешивает identifier quoting с values.
- Hash включает `schema_version`, поэтому поддержанное DDL меняет и version, и hash даже если итоговая видимая модель эквивалентна предыдущей.
- Cache хранит manifest только до изменения `schema_version`; cache key внешнего слоя по-прежнему обязан включать полный tenant tuple и generation из `@mekka/protocol`.
- В manifest сохраняются все `index_xinfo` entries, включая non-key rowid entries, чтобы не терять SQLite index semantics.

## Измененные файлы
- `packages/schema-manifest/src/index.ts`: model, SQLite introspection, canonical hashing, cache и validation.
- `packages/schema-manifest/test/schema-manifest.test.ts`: integration/golden and negative tests.
- `packages/schema-manifest/package.json`: package metadata and workspace dependency.
- `packages/schema-manifest/tsconfig.json`: composite project configuration.
- `packages/schema-manifest/README.md`: public contract and SQLite support boundary.
- `package.json`: manifest suite added to root test command.
- `tsconfig.json`: manifest package added to project references.
- `bun.lock`: workspace lockfile updated for the package.

## Безопасность
- Introspection names never become SQL interpolation: SQLite table-valued PRAGMA parameters are bound through StorageAdapter.
- No public raw SQL or caller-controlled PRAGMA capability is introduced.
- Runtime metadata tables and SQLite internals are omitted; table data, default secrets stored in rows and DDL SQL are not exposed.
- Invalid metadata and unsupported engine version fail closed with explicit errors rather than emitting a partial manifest.

## Проверки
- `C:\Users\ilyaa\.bun\bin\bun.exe run typecheck`: PASSED.
- `C:\Users\ilyaa\.bun\bin\bun.exe test packages/schema-manifest/test/schema-manifest.test.ts`: PASSED, 4 tests.
- `git diff --check`: PASSED.
- `C:\Users\ilyaa\.bun\bin\bun.exe run check`: PASSED: format check, lint, typecheck, 20 tests, build and health smoke test.

## Совместимость
- Поддерживается SQLite `3.37.0`+ with table-valued PRAGMA metadata queries.
- PostgreSQL schemas, policies, functions, views, triggers, virtual tables and migrations metadata are out of scope.
- The manifest is a product format version `1`, not a claim of full PostgreSQL or Supabase catalog compatibility.

## Ограничения и риски
- Schema cache correctness across processes depends on the future tenant-scoped cache owner and generation-aware key; this package only handles a single StorageExecutor lifecycle.
- DDL admission, migrations metadata, policies and destructive-change checkpoints are deferred to their dedicated sessions.
- SQLite documents that PRAGMA result sets can gain columns in future versions; implementation selects only named columns required by format version `1`.

## Следующая рекомендуемая сессия
- `SESSION-0005`: parse the constrained REST query dialect into a typed AST that resolves identifiers through this manifest.
