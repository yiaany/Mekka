# SESSION-0027: Preview branch lifecycle

## Цель
Создавать изолированную preview database, применять migration и безопасно продвигать artifact.

## Зависимости
- SESSION-0010, SESSION-0017.

## Upstream Sources
- `https://github.com/tursodatabase/libsql` и `https://github.com/tursodatabase/turso`.
- Клонировать/pin relevant commits, изучить backup/replication/branch primitives.
- Если используется managed Turso, проверить официальный branching API; не симулировать недоказанную capability.

## Scope
- Create/list/delete branch, parent checkpoint, separate credentials и TTL.
- Empty/synthetic Auth preview store.
- Migration validation, CAS promotion и restore point.

## Out of Scope
- Merge произвольных divergent data и PII masking UI.

## Acceptance Criteria
1. Branch изолирован от parent writes.
2. Stale target hash блокирует promotion.
3. Retry promotion идемпотентен.
4. TTL cleanup не удаляет production.

## Security
- Branch-bound credentials, no production sessions/PII by default, audit.

## Tests
- Isolation, conflict, retry, restore и cleanup race tests.

## Deliverables
- Branch service/API, tests, engine capability record и Session Log.
