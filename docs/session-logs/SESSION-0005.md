# SESSION-0005: PostgREST filter parser

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/query-ast`, преобразующий ограниченный URL query subset в immutable typed AST без генерации SQL.
- Поддержаны root `select`, filters `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, boolean groups `and`/`or` с `not.`, root `order`, `limit` и `offset`.
- Table и columns резолвятся только через `SchemaManifest`; hidden и неизвестные columns, а также неизвестные tables, отклоняются до AST.
- Введены стабильные ошибки `QUERY_AST_MALFORMED`, `QUERY_AST_UNSUPPORTED`, `QUERY_AST_VALIDATION` и `QUERY_AST_LIMIT`.
- Добавлены лимиты decoded URL length, boolean group depth, AST nodes и list size. Parser не использует regex над query input; recursion ограничена `maxDepth`.
- Добавлены reference-style, negative и malformed fuzz-corpus tests, а также матрица поддерживаемого subset.

## Upstream
- Изучен официальный `https://github.com/PostgREST/postgrest`, tag `v14.16`, commit `673bbbf291d5a3b6bda65cf5cf7c340f858a0531`, проверен 3 августа 2026 года.
- License: MIT, copyright (c) 2014 Joe Nelson and (c) 2019 Steve Chavez.
- Временно клонирован в `C:\Users\ilyaa\AppData\Local\Temp\opencode\postgrest-v14.16`; изучены `LICENSE`, `docs/references/api/url_grammar.rst`, `tables_views.rst`, `pagination_count.rst`, `src/PostgREST/ApiRequest/QueryParams.hs` и `test/spec/Feature/Query/AndOrParamsSpec.hs`.
- Извлечены только syntax/contracts для `select`, simple filters, `in`, `is`, boolean groups, `order`, `limit` и `offset`. Haskell source/tests не копировались и не vendor-ились; поэтому LICENSE/NOTICE upstream в продукт не добавлялись.

## Архитектурные решения
- AST принимает raw string values: type coercion и prepared-statement binding принадлежат следующему SQLite compiler, а parser не допускает SQL generation.
- Все root filter parameters не являются map key, поэтому несколько filters на одной column сохраняются в детерминированном query order и объединяются implicit `and`.
- `select`, `order`, `limit` и `offset` единичны; повторение отклоняется, чтобы исключить неоднозначную semantics.
- Scope намеренно ограничен root resource: embed paths, aliases, JSON paths, casts, aggregates, FTS, pattern/range/array operators и Range headers дают explicit unsupported error или отсутствуют по scope.

## Измененные файлы
- `packages/query-ast/src/index.ts`: typed AST, schema-aware parser, URL decoding, stable errors и complexity limits.
- `packages/query-ast/test/query-ast.test.ts`: reference, validation, malformed and bounded fuzz-corpus tests.
- `packages/query-ast/package.json`, `packages/query-ast/tsconfig.json`: workspace package configuration.
- `packages/query-ast/README.md`, `packages/query-ast/SUPPORTED.md`: contract и compatibility matrix.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace integration, test script и project reference.

## Безопасность
- Table/column identifiers не становятся SQL text и не принимаются без allowlist из schema manifest.
- Parsed values остаются data-only AST values; SQL compiler обязан использовать prepared statements.
- Invalid percent encoding, malformed groups/lists, unknown identifiers/operators и unsupported constructs fail closed со стабильными codes.
- Decoded input length, recursive group depth, node count и list size ограничены; adversarial nesting не может вызвать unbounded recursion.

## Проверки
- `C:\Users\ilyaa\.bun\bin\bun.exe test packages/query-ast/test/query-ast.test.ts`: PASSED, 6 tests.
- `C:\Users\ilyaa\.bun\bin\bun.exe run typecheck`: PASSED.
- `C:\Users\ilyaa\.bun\bin\bun.exe run check`: PASSED: format check, lint, typecheck, 26 tests, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Поддерживается ограниченный root-resource query subset PostgREST `v14.16`: flat select, simple comparisons, `in`, `is`, boolean groups, order and query pagination.
- `+` decoding and percent encoding follow standard URL query parsing; quoted and escaped `in` values are retained as AST data.
- Не заявляется PostgreSQL/Supabase parity для embedding, JSON operators, casts, aggregates, `like`/`ilike`, regex, FTS, arrays, ranges, modifiers, relation ordering или Range request headers.

## Ограничения и риски
- SQLite value type coercion, NULL comparison translation, `is.unknown`, order NULL semantics и final parameter binding еще не реализованы: это обязанность `SESSION-0006` SQLite compiler.
- Parser package не делает authorization, tenant routing, quotas или response row limits; caller обязан применять tenant context/policy engine и transport limits.
- Direct scalar filter values containing boolean-group delimiters should be percent-encoded; quote syntax beyond `in` is intentionally not implemented in this subset.

## Следующая рекомендуемая сессия
- `SESSION-0006`: compile this AST into SQLite prepared statements with identifier allowlist, explicit NULL semantics and compiler contract tests.
