# SESSION-0003: SQLite StorageAdapter

## Цель
Создать первый storage engine adapter с обязательными SQLite connection invariants.

## Зависимости
- SESSION-0001, SESSION-0002.

## Upstream Sources
- `https://github.com/tursodatabase/libsql` и `https://github.com/tursodatabase/libsql-client-ts`.
- Временно клонировать оба repository с `--filter=blob:none`, проверить LICENSE, pin commit.
- Изучить client API, transactions, backup/replication limitations; не vendor-ить engine source.

## Scope
- Определить минимальный `StorageAdapter` из реально используемых операций.
- Реализовать local SQLite/libSQL adapter, lifecycle и temporary test database.
- Централизовать foreign keys, journal/synchronous mode, busy timeout и version checks.

## Out of Scope
- Remote replication, branches и multi-node ownership.

## Acceptance Criteria
1. Adapter выполняет parameterized query и transaction.
2. Connection invariants проверяются при открытии.
3. Несовместимая engine version завершается explicit error.

## Security
- No raw value concatenation; dangerous extensions/PRAGMA запрещены.
- Database path проходит validation.

## Tests
- Integration tests transaction commit/rollback, FK enforcement, busy handling и cleanup.

## Deliverables
- Adapter, conformance tests, upstream provenance и Session Log.
