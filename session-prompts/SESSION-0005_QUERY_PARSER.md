# SESSION-0005: PostgREST filter parser

## Цель
Разбирать безопасный subset PostgREST URL query в typed AST без генерации SQL.

## Зависимости
- SESSION-0002, SESSION-0004.

## Upstream Sources
- `https://github.com/PostgREST/postgrest`.
- Временно клонировать pinned commit; изучить docs/tests для `select`, `eq`, `neq`, comparisons, `in`, `is`, `and`, `or`, order/range.
- Не переносить Haskell/PostgreSQL implementation.

## Scope
- Parser `select`, filters, boolean groups, order, limit и offset.
- Schema-aware validation columns/operators.
- Complexity limits: depth, nodes, list size и decoded URL length.

## Out of Scope
- SQL, mutations, RPC, FTS и nested embedding.

## Acceptance Criteria
1. Valid subset дает deterministic AST.
2. Unknown identifiers/operators дают stable unsupported/validation errors.
3. Malformed and adversarial input не вызывает unbounded recursion.

## Security
- Fuzz-safe parser; no eval/regex DoS.

## Tests
- Unit, property/fuzz corpus и reference examples PostgREST.

## Deliverables
- `query-ast` parser, tests, supported matrix и Session Log.
