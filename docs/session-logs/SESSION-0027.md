# SESSION-0027: Preview branch lifecycle

## Результат
COMPLETED

## Что сделано
- Добавлен `@mekka/branch-core` с durable SQLite catalog, service/API для create/list/delete preview branch, apply migration, CAS promotion и TTL cleanup.
- Branch создается из одного parent checkpoint под обязательным `withMutationLock`. Полный source snapshot используется только как staging artifact; user rows удаляются, а опубликованные branch database и immutable branch checkpoint заново создаются через `VACUUM INTO`, поэтому production rows не остаются в final preview file или его freed pages.
- Preview получает отдельный tenant-bound credential через внешний issuer. Credential ID резервируется до issuance, raw token не сохраняется в catalog и API create response помечен `Cache-Control: no-store`.
- Добавлен `createProjectAuthPreviewStoreLifecycle`: preview Auth store создается пустым или только с synthetic users, а production accounts, sessions и credentials не копируются.
- Migration artifact журналируется до DDL. Crash reconciliation различает committed и uncommitted migration по `_mekka_migrations`, завершает committed result или возвращает branch в `active` после deterministic failure.
- Promotion replay использует исходный migration SQL, проверяет immutable parent schema hash, создает production restore point, применяет migration под parent mutation lock и хранит idempotent result. Startup reconciliation завершает catalog/audit после уже committed production migration либо безопасно удаляет unapplied promotion и orphan restore file.
- TTL/manual cleanup используют монотонные `deleting`/`deleting_active` states, не конкурируют с migration/promotion, повторяемо удаляют branch database, Auth, credential, parent checkpoint и promotion restore points.
- Добавлен внутренний durable audit ledger; сбой внешнего audit sink не откатывает уже committed lifecycle operation.
- Добавлена capability matrix для local SQLite, libSQL, Turso Database и Turso Cloud без симуляции неподтвержденного managed adapter.

## Upstream
- `https://github.com/tursodatabase/libsql`, commit `6f451a1fabacbcbc9960b232b4c1605a5021979b` от 1 июля 2026 года, MIT. Clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\libsql-session-0027`.
- Изучены `libsql-replication/src/snapshot.rs`, replication snapshot flow, `vendored/rusqlite/src/backup.rs` и `bottomless/src/backup.rs`. Подтверждены replication/online-backup primitives, но product-level branch lifecycle из них не выводится.
- `https://github.com/tursodatabase/turso`, commit `bc62e48718d5cfe8388deb57f9de5fa9d572c3ae` от 5 августа 2026 года, MIT. Clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\turso-session-0027`.
- Изучены engine README/manual, checkpoint/snapshot tests и отсутствие managed cloud branching contract в in-process engine repository.
- Проверены официальные Turso Platform API contracts создания database из существующей database и отдельной database token issuance. Managed adapter не реализован и не симулируется.
- Upstream source code не копировался. LICENSE/NOTICE product tree не менялись; provenance зафиксирован в `docs/engine-capabilities/branching.md`.

## Архитектурные решения
- Durable reservation создается до filesystem/Auth/credential side effects. Concurrent create одной tenant generation не может удалить ресурсы победившего запроса.
- Retained parent checkpoint является schema-only branch baseline; original production schema hash хранится отдельно для promotion CAS.
- В lifecycle version 1 допускается один migration artifact на branch. Это исключает promotion отдельного позднего artifact вне schema context предыдущих migration.
- Production checkpoint, CAS и migration apply сериализуются одним resolver-owned `withMutationLock`; gateway replicas не считаются writer coordination.
- Promotion применяет migration artifact, а не branch database file. Preview test data никогда не переносится в parent.
- Internal audit записывается в той же catalog transaction, что и конечный lifecycle state. External sink является delivery boundary, а не correctness boundary.
- Persisted absolute paths всегда повторно проверяются относительно approved database/checkpoint roots перед удалением.

## Измененные файлы
- `packages/branch-core/src/index.ts`: branch catalog, lifecycle state machine, local SQLite provisioning, API, CAS promotion, reconciliation, TTL cleanup, audit и engine capabilities.
- `packages/branch-core/test/branch-core.test.ts`: isolation, PII scrubbing, concurrent create, stale CAS, retry, restore point, migration/promotion crash recovery, production-only conflict, delete/promotion race, TTL race и API authorization tests.
- `packages/branch-core/{package.json,tsconfig.json,README.md}`: workspace package contract и operational invariants.
- `packages/auth-core/src/index.ts`: production preview Auth lifecycle и bounded Windows cleanup retry.
- `packages/auth-core/test/auth-core.test.ts`: real preview lifecycle test без production accounts/sessions/credentials.
- `packages/migration-engine/src/index.ts`: schema CAS переносится внутрь transaction; restore поддерживает отдельный approved source directory.
- `packages/migration-engine/README.md`: обновлен restore contract.
- `docs/engine-capabilities/branching.md`: upstream pins, licenses и capability decisions.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace/test/build integration.

## Безопасность
- Branch и capability решения используют полный tenant tuple и generation; API дополнительно проверяет exact parent tenant.
- Preview final database/checkpoint не содержат production rows; raw staging snapshot удаляется до Auth/credential publication и принадлежит durable recovery reservation.
- Credential tenant binding, exact preallocated ID, HTTPS URL без credentials/query/fragment и expiry проверяются до публикации; token не сохраняется и не попадает в list/promotion responses.
- Stale target hash блокирует promotion до production mutation. Parent mutation lock закрывает race между CAS, restore point и apply.
- Migration/promotion/delete states исключают взаимное удаление resource во время mutation. Cleanup не выбирает production database и принимает только cataloged preview rows.
- Crash recovery не делает fail-open: unknown/unapplied migration возвращается в `active`, committed ledger завершается, orphan production restore point удаляется по детерминированному path.
- Public API не возвращает filesystem paths, checkpoint paths и internal credential IDs; unexpected errors редактируются protocol envelope.
- По итоговому self-review известных Critical/High проблем в измененном path нет.

## Проверки
- `bun test packages/branch-core/test/branch-core.test.ts`: PASSED, 13 tests.
- `bun test packages/auth-core/test/auth-core.test.ts`: PASSED, 13 tests.
- `bun test packages/migration-engine/test/migration-engine.test.ts`: PASSED, 4 tests.
- `bun run check`: PASSED на повторном полном запуске: format, lint, typecheck, 152 tests, build и health smoke.
- Первый `bun run check`: FAILED из-за transient Windows `EBUSY` в существующем `apps/gateway/test/storage.test.ts` cleanup; немедленный повтор без code changes прошел 152/152 tests.
- `git diff --check`: PASSED.
- `cargo test -p libsql_replication snapshot --lib`: NOT RUN, локальный `cargo` отсутствует; Docker CLI установлен, но Docker daemon недоступен. Upstream code не копировался и не исполняется product path, поэтому product gate покрыт local adapter integration/restore tests.

## Совместимость
- Supported: local Bun SQLite preview branch с schema-only data, synthetic/empty Auth, separate credentials, one migration artifact, CAS promotion, restore point, idempotent retry, TTL/manual cleanup и crash reconciliation.
- Supported API actions: `branch:create`, `branch:list`, `branch:migrate`, `branch:promote`, `branch:delete` через trusted `TenantContext`.
- Verified only: libSQL replication snapshots и Turso Cloud database-copy/token API.
- Unsupported: managed Turso adapter, arbitrary divergent data merge, multiple dependent migrations in one branch lifecycle, production data copy/masking, in-place restore и branch file promotion.

## Ограничения и риски
- Все production writers обязаны использовать тот же `withMutationLock`; обход этого boundary нарушит checkpoint/CAS consistency.
- Credential issuer и Auth lifecycle должны быть idempotent по preallocated credential ID/full tenant tuple.
- Transient source snapshot содержит production data до sanitization и требует encrypted approved storage в production; он не публикуется preview client и удаляется до credential issuance.
- Backup metadata проверяет SQLite integrity и schema fingerprint, но пока не содержит authenticated full-file digest/object-store version.
- Managed Turso capability требует отдельного adapter, API polling/error model, token revocation и conformance suite.
- Upstream Rust tests не запущены из-за отсутствующего Rust toolchain и недоступного Docker daemon; upstream code не был адаптирован или включен в runtime.

## Следующая рекомендуемая сессия
- `SESSION-0028`: read-only MCP tools для inspect schema/data с branch-bound capabilities и audit.
