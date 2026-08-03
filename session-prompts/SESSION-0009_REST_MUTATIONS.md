# SESSION-0009: REST mutations

## Цель
Добавить безопасные insert, update, delete и upsert для Data API.

## Зависимости
- SESSION-0008.

## Upstream Sources
- `https://github.com/PostgREST/postgrest` и `https://github.com/supabase/supabase-js`.
- Клонировать/pin при отсутствии local reference; изучить mutation headers, return modes и upsert client behavior.

## Scope
- Mutation AST/compiler и HTTP endpoints.
- `Prefer: return=minimal|representation` subset.
- Idempotency key, affected-row preflight и explicit bulk capability.

## Out of Scope
- RPC, nested writes и arbitrary conflict targets.

## Acceptance Criteria
1. CRUD mutation применяет policies к old/new rows.
2. Retry с idempotency key не дублирует write.
3. Unbounded update/delete запрещен без bulk capability.

## Security
- Transactions, row caps, no mass-assignment запрещенных fields.

## Tests
- HTTP integration, policy bypass, conflict, retry и rollback tests.

## Deliverables
- Compiler/endpoints, tests, compatibility matrix и Session Log.
