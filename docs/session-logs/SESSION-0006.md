# SESSION-0006: SQLite SELECT compiler

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/sqlite-compiler`, компилирующий versioned `QueryAst` в один parameterized SQLite `SELECT`.
- Поддержаны projection, filters `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, nested boolean groups с `not.`, order, `limit` и `offset`.
- Результат содержит SQL, immutable positional parameters и cost metadata: число selected columns, filter nodes, boolean groups, order terms и bind parameters.
- Добавлена повторная validation AST table, projection/filter/order columns через supplied `SchemaManifest`; identifiers double-quoted только после allowlist validation.
- Все scalar values, элементы `in`, `limit` и `offset` попадают в `?` parameters. При `offset` без `limit` используется bound SQLite limit `-1`.
- Добавлены golden compiler, injection, forged AST/identifier, compiler-limit и temporary SQLite integration tests.

## Upstream
- Проверена официальная SQLite documentation для `SELECT`, expressions, `IS`, `IN`, `ORDER BY`, `LIMIT/OFFSET` и parameters 3 августа 2026 года.
- SQLite core распространяется как Public Domain. Код, документация и tests SQLite не копировались и не vendor-ились; attribution files не добавлялись.

## Архитектурные решения
- Компилятор повторно валидирует externally supplied AST, а не полагается только на parser: это сохраняет identifier boundary, если AST получен не из `parseQuery`.
- Значения parser остаются strings и передаются SQLite как bound values. SQLite affinity выполняет type coercion; отдельный semantic type system не добавлялся вне scope.
- `is.null` и `is.unknown` компилируются как `IS NULL`; `is.not_null`, `is.true` и `is.false` используют SQLite `IS` predicates.
- Default cap в 500 parameters намеренно ниже обычного SQLite default variable limit, чтобы policy rewriter в следующем слое мог добавлять собственные predicates без непредсказуемого переполнения.

## Измененные файлы
- `packages/sqlite-compiler/src/index.ts`: compiler, errors, limits, identifier boundary и cost metadata.
- `packages/sqlite-compiler/test/sqlite-compiler.test.ts`: unit golden/negative/injection tests и integration query на temporary SQLite database.
- `packages/sqlite-compiler/package.json`, `packages/sqlite-compiler/tsconfig.json`: workspace package configuration.
- `packages/sqlite-compiler/README.md`: public contract, SQLite semantics и security limits.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace integration, test command, TypeScript project reference и package resolution.

## Безопасность
- User-controlled values never concatenate into SQL, включая pagination; они передаются только через positional bound parameters.
- Table и column names обязаны находиться в manifest visible-column allowlist и после этого strict double-quoted; forged и hidden identifiers fail closed.
- Bounded `in` lists и total bind parameters предотвращают unbounded statement construction и превышение variable budget.
- Malformed, unknown-version, unsupported, validation и limit conditions получают stable compiler error codes; raw SQL capability не добавлен.

## Проверки
- `bun test packages/sqlite-compiler/test/sqlite-compiler.test.ts`: PASSED, 5 tests.
- `bun run typecheck`: PASSED.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `bun run check`: PASSED: format check, lint, typecheck, 31 tests, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Поддерживается ограниченный root-resource subset AST из `SESSION-0005`: flat projection, simple comparison, `in`, `is`, nested boolean groups, root ordering и query pagination.
- Не заявляется PostgreSQL/Supabase parity для joins/embed, policies, JSON, casts, aggregates, pattern/regex/FTS operators, arrays, ranges, collations, custom functions, request range headers или mutations.

## Ограничения и риски
- Compiler не выполняет authorization, tenant routing, policy rewrite, rate limiting, query planning или response row/byte limits; эти boundaries принадлежат следующим слоям request path.
- SQLite type affinity может отличаться от PostgreSQL semantics для text-to-numeric comparison и booleans; compatibility matrix должна фиксировать behavior transport layer до публичного Supabase-compatible API.
- `NULLS FIRST/LAST` требует SQLite version support, предоставляемый текущим StorageAdapter minimum engine version; alternate adapters должны подтвердить это conformance test-ами.

## Следующая рекомендуемая сессия
- `SESSION-0007`: добавить policy rewriter между validated AST и compiler с tenant-aware deny-by-default predicates.
