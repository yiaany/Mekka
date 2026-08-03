# SESSION-0024: SQLite Realtime changefeed

## Цель
Создать надежный источник database change events без PostgreSQL logical replication.

## Зависимости
- SESSION-0003, SESSION-0007, SESSION-0009.

## Upstream Sources
- `https://github.com/supabase/realtime`.
- Клонировать/pin commit, изучить event envelope, subscription semantics и tests.
- PostgreSQL replication code не переносить.

## Scope
- Transactional outbox/change journal для writes через gateway.
- Event ID, transaction metadata, at-least-once delivery и retention cursor.
- Redacted row payload согласно policy needs.

## Out of Scope
- WebSocket clients, Broadcast, Presence и direct-SQL writes outside trusted path.

## Acceptance Criteria
1. Committed write создает event; rollback не создает.
2. Consumer retry не теряет event и может deduplicate.
3. Retention gap возвращает explicit resync requirement.

## Security
- Tenant partitioning, PII minimization и no event before commit.

## Tests
- Transaction, crash/retry, ordering и cross-tenant event tests.

## Deliverables
- `realtime-core` changefeed, tests, semantics docs и Session Log.
