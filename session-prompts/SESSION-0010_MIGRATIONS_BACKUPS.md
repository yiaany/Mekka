# SESSION-0010: Migration artifacts и backups

## Цель
Сделать schema changes versioned, проверяемыми и восстанавливаемыми.

## Зависимости
- SESSION-0003, SESSION-0004.

## Upstream Sources
- SQLite online backup API/VACUUM INTO documentation.
- При использовании libSQL/Turso clone/pin relevant engine docs/source для snapshot semantics.

## Scope
- Migration artifact schema, hashes, actor и idempotency.
- Migration ledger, apply state machine и schema hash conflict.
- Supported backup/checkpoint primitive и verified restore.

## Out of Scope
- Branch merge и UI.

## Acceptance Criteria
1. Migration retry безопасен.
2. Stale schema hash отклоняется.
3. Restore возвращает проверенную schema/data fixture.
4. Live database не копируется небезопасным file copy.

## Security
- DDL allowlist, dangerous schema constructs blocked, audit event.

## Tests
- Migration conflict/retry, interrupted apply и automated restore drill.

## Deliverables
- `migration-engine`, backup runbook, tests и Session Log.
