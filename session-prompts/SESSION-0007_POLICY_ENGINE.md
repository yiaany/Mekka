# SESSION-0007: Policy engine v1

## Цель
Добавить deny-by-default row/field authorization до SQL execution.

## Зависимости
- SESSION-0002, SESSION-0004, SESSION-0006.

## Upstream Sources
- `https://github.com/supabase/supabase` только как UX/reference для RLS concepts.
- Временно клонировать и изучить relevant Studio policy UI; PostgreSQL RLS SQL не переносить.

## Scope
- Typed policy model для select/insert/update/delete.
- Compile actor/row/input predicates в query AST.
- Field allow/deny и policy simulator.

## Out of Scope
- Prompt-to-policy и Studio editor.

## Acceptance Criteria
1. Без policy public operation запрещена.
2. Select/update/delete ограничиваются row predicate.
3. Insert/update проверяют new values.
4. Simulator и runtime дают одинаковое решение.

## Security
- Direct DB access считается trusted admin path и не выдается клиенту.
- Tests закрывают cross-tenant и policy bypass cases.

## Tests
- Unit matrix allow/deny и integration tests всех CRUD actions.

## Deliverables
- `policy-engine`, tests, policy format и Session Log.
