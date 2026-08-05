# SESSION-0003: SQLite StorageAdapter

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/storage-core` с минимальным синхронным `StorageAdapter`: parameterized single-statement execution, атомарный callback transaction и lifecycle `close`.
- Local adapter использует Bun `bun:sqlite` для SQLite-compatible local database, в том числе libSQL-compatible SQL subset на storage boundary.
- При открытии соединения централизованно устанавливаются и проверяются `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL` и bounded `busy_timeout`; in-memory database допускает SQLite fallback `journal_mode=memory`.
- Добавлена минимальная совместимая версия SQLite (`3.35.0` по умолчанию) и явная ошибка `STORAGE_ENGINE_VERSION_UNSUPPORTED` для несовместимого engine.
- Добавлены явные adapter errors для invalid path, forbidden query, unsupported engine version и busy timeout.
- Публичный execution path принимает только prepared positional parameters. Запрещены multiple statements, caller-controlled PRAGMA, transaction control, `ATTACH`, `DETACH` и `VACUUM`.
- Добавлены integration conformance tests для parameter binding, connection invariants, commit/rollback, FK enforcement, busy handling, path validation, engine-version failure и temporary database cleanup.

## Upstream
- `https://github.com/tursodatabase/libsql`, commit `6f451a1fabacbcbc9960b232b4c1605a5021979b` (1 июля 2026 года), LICENSE: MIT. Проверены local SQLite, transaction и replication-related boundaries; engine source не vendor-ился.
- `https://github.com/tursodatabase/libsql-client-ts`, commit `889a2ec3130b9fb3b32fda9e19ebd33864efc509` (15 июня 2026 года), LICENSE: MIT. Проверены `file:` client, `execute` with bound arguments, transaction lifecycle, local busy timeout и `sync()` API.
- Оба upstream repository были временно клонированы с `--filter=blob:none` в `C:\Users\ilyaa\AppData\Local\Temp\opencode`. Код, LICENSE и branding upstream не копировались, поэтому attribution files в product tree не требуются.
- Remote sync/replication и backup primitives client API намеренно не используются: они находятся вне scope и требуют отдельной ownership/restore design.

## Архитектурные решения
- Adapter намеренно синхронный, потому что `bun:sqlite` local API синхронный. Будущая remote/libSQL implementation должна реализовать тот же маленький contract, а не вытекать в product semantics.
- Transaction начинается через runtime transaction primitive, а не пропускает SQL transaction-control statements от callers. Это сохраняет rollback при exception и не допускает обход lifecycle.
- File database path допускается только внутри caller-supplied approved directory; `:memory:` оставлен исключительно для ephemeral/local tests.
- WAL обязателен для file-backed database. SQLite возвращает `memory` journal mode для `:memory:`, что является documented runtime limitation и разрешено только для этого non-persistent режима.
- Backups нельзя делать копированием live file; backup/restore будет следующей отдельной feature на supported snapshot primitive.

## Измененные файлы
- `packages/storage-core/src/index.ts`: storage contract, local SQLite adapter, validation, invariants и errors.
- `packages/storage-core/test/storage-adapter.test.ts`: SQLite integration/conformance tests.
- `packages/storage-core/package.json`: package metadata.
- `packages/storage-core/tsconfig.json`: composite TypeScript project.
- `packages/storage-core/README.md`: scope, connection contract и upstream provenance reference.
- `package.json`: storage integration suite добавлен в root test script.
- `tsconfig.json`: storage package добавлен в project references.

## Безопасность
- Значения передаются Bun prepared statement bindings, а не конкатенируются с SQL.
- Database path не может покинуть explicit approved directory.
- Callers не могут изменить `foreign_keys`, journal, synchronous или busy timeout через PRAGMA и не могут использовать `ATTACH`/`DETACH`.
- Transaction-control SQL и multi-statement SQL запрещены, поэтому caller не может обойти managed transaction lifecycle.
- FK invariant и busy-timeout проверяются integration tests; lock contention возвращает stable `STORAGE_BUSY`, а не скрытый retry/fail-open.

## Проверки
- `C:\Users\ilyaa\.bun\bin\bun.exe run typecheck`: PASSED.
- `C:\Users\ilyaa\.bun\bin\bun.exe test packages/storage-core/test/storage-adapter.test.ts`: PASSED, 5 tests.
- `C:\Users\ilyaa\.bun\bin\bun.exe run check`: PASSED, format check, lint, typecheck, 16 tests, build и health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Поддерживается local SQLite execution через Bun 1.3.14 and SQLite-compatible parameterized SQL.
- `@libsql/client` API и remote protocols не являются runtime dependency; adapter contract оставлен малым для отдельной remote implementation.
- Не поддерживаются arbitrary SQL scripts, custom PRAGMA, extensions, virtual tables, UDF, `ATTACH`, `DETACH`, remote replication, branches, backups и multi-node ownership.

## Ограничения и риски
- `bun:sqlite` не предоставляет remote libSQL transport; подключение Turso/libSQL remote требует отдельной adapter implementation и contract suite.
- Current contract принимает trusted internal SQL templates. Identifier allowlist и typed Query AST/compiler будут добавлены в следующих sessions; public API не должен передавать raw SQL в adapter.
- Busy retry strategy не реализована намеренно: retry/idempotency должен жить выше adapter с operation semantics, а не скрывать result ambiguity в database driver.

## Следующая рекомендуемая сессия
- `SESSION-0004`: построить schema manifest и identifier allowlist поверх StorageAdapter.
