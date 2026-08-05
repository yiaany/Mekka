# SESSION-0010: Migration artifacts и backups

## Результат
COMPLETED

## Что сделано
- Добавлен `@mekka/migration-engine` с versioned, SHA-256-addressed `MigrationArtifact`: migration id, actor, idempotency key, expected schema hash и ограниченный DDL.
- Добавлен transactional internal ledger `_mekka_migrations`, который хранит artifact hash, actor, idempotency key, expected/result schema hash и states `applying`/`applied`.
- Apply проверяет schema hash target до DDL. Повтор того же artifact id/hash возвращает committed result (`replayed`); reuse id с отличающимся artifact возвращает conflict.
- Разрешен один bounded DDL statement: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN` или `CREATE [UNIQUE] INDEX`. Multi-statement DDL, destructive DDL, triggers, views, virtual tables, `ATTACH`, `PRAGMA`, `VACUUM`, extensions и rename paths blocked.
- `StorageAdapter` получил internal `createCheckpoint`, реализованный SQLite `VACUUM INTO` с approved destination path и запретом overwrite.
- Добавлены `createCheckpoint` и `restoreCheckpoint`: restore открывает checkpoint, проверяет `pragma_integrity_check` и schema fingerprint, затем создает новую target database с `VACUUM INTO`, снова проверяя integrity/schema.
- Добавлен backup/restore runbook.

## Upstream
- SQLite official documentation verified 3 August 2026: `https://www.sqlite.org/backup.html`, `https://www.sqlite.org/c3ref/backup_finish.html`, and `https://sqlite.org/lang_vacuum.html`.
- SQLite documentation describes the Online Backup API as the original live-backup mechanism. `VACUUM INTO` creates a vacuumed snapshot into a new file; its destination must be new or empty, and an interrupted process can leave an incomplete output.
- The Bun `bun:sqlite` API available in this repository does not expose SQLite's incremental online backup API. The implementation therefore uses one internal `VACUUM INTO` command with a bound destination, followed by verified reopen/restore; raw source file copying is never used.
- SQLite source and documentation are public domain. No upstream source, documentation text or tests were copied into the product tree.

## Архитектурные решения
- Artifact schema hash is the normal `SchemaManifest.hash`, including SQLite `schema_version`, and is used to reject stale migration targets.
- Backup verification uses a separate SHA-256 fingerprint of manifest tables, excluding local `schema_version`. A reconstructed database can have a different SQLite schema version despite equivalent schema/data.
- Ledger creation, `applying` state, DDL and `applied` state execute in one StorageAdapter transaction. Failed DDL rolls back both schema change and ledger insert.
- A checkpoint destination must not already exist. Restore always targets a new path rather than replacing a live database.

## Измененные файлы
- `packages/migration-engine/src/index.ts`: artifacts, DDL admission, ledger, apply lifecycle, checkpoint and restore.
- `packages/migration-engine/test/migration-engine.test.ts`: retry, stale schema, identifier conflict, interrupted apply and restore drill tests.
- `packages/migration-engine/{package.json,tsconfig.json,README.md}`: package contract and workspace integration.
- `packages/storage-core/src/index.ts`: managed `VACUUM INTO` checkpoint primitive.
- `docs/runbooks/sqlite-backup-restore.md`: operational checkpoint and restore procedure.
- `package.json`, `tsconfig.json`, `bun.lock`: migration-engine workspace and root test/project references.

## Безопасность
- Migration target must match the artifact's expected schema hash; stale artifacts fail before DDL.
- Artifact integrity is checked by recomputing its SHA-256 hash.
- DDL admission is deny-by-default and blocks trigger/view/virtual-table paths that could escape the current policy model.
- The migration ledger captures actor and idempotency key transactionally for future audit integration.
- Backup/restore uses SQLite snapshot primitives and approved paths, not unsafe live file copies. Checkpoint and restored database both undergo integrity and schema verification.

## Проверки
- `bun test packages/migration-engine/test/migration-engine.test.ts`: PASSED, 4 tests.
- `bun run typecheck`: PASSED.
- `bun run check`: PASSED: format check, lint, typecheck, full tests, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Supported: local Bun SQLite `VACUUM INTO` checkpoints, verified restore to a new local SQLite path, constrained additive DDL.
- Unsupported: direct filesystem copy of active SQLite, in-place restore, destructive migrations, arbitrary SQL scripts, triggers/views/extensions/virtual tables, libSQL/Turso snapshots and retention jobs.
- Remote/libSQL/Turso backup semantics require a dedicated adapter implementation and conformance suite before use.

## Ограничения и риски
- `VACUUM INTO` is a consistent snapshot but an unplanned interruption can leave a corrupt incomplete destination; restore verification rejects it. Production backup publication still needs atomic object-store promotion after verification.
- The current Bun adapter does not expose the incremental SQLite Online Backup API, so long-running checkpoint workload has no progress/cancellation interface yet.
- Audit events are presently recorded in the internal migration ledger only; centralized immutable audit persistence arrives with the teams/audit session.
- No backup retention, encryption, object storage transfer or restore traffic cutover exists yet.

## Следующая рекомендуемая сессия
- `SESSION-0011`: SQLite Meta API that generates these constrained migration artifacts and requires checkpoint/confirmation for destructive operations.
