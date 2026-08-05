# @mekka/sqlite-compiler

`@mekka/sqlite-compiler` compiles the bounded `@mekka/query-ast` read subset into one SQLite
`SELECT` statement plus positional bound parameters.

## Contract

- The compiler re-resolves the AST table, projected columns, filters, and order terms through the
  supplied `SchemaManifest`. Hidden and absent identifiers never become SQL text.
- Every user-controlled scalar, `in` item, `limit`, and `offset` is a `?` bound parameter.
- Identifiers are double-quoted after manifest validation. The compiler supports no joins, raw SQL,
  expressions, policies, or mutations.
- `is.null` and `is.unknown` compile to `IS NULL`; `is.not_null`, `is.true`, and `is.false` map to
  SQLite `IS` predicates. Filter and group negation are applied with `NOT (...)`.
- Default limits cap `in` lists at 100 values and all bind parameters at 500. The parameter cap is
  intentionally below SQLite's commonly configured variable limit to reserve capacity for later
  policy predicates.

SQLite SELECT and parameter binding behavior are based on official SQLite documentation. No SQLite
source or documentation is vendored.
