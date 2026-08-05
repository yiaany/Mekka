# @mekka/query-ast

`@mekka/query-ast` parses a bounded, schema-validated root-resource subset of PostgREST query
parameters into an immutable AST. It never produces SQL.

## Supported syntax

- `select=*` or a comma-separated root column list.
- Root filters with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, and optional `not.`.
- Root `and`, `or`, `not.and`, and `not.or` groups.
- Root `order=column[.asc|desc][.nullsfirst|nullslast]`, `limit`, and `offset`.
- Percent decoding and `+` as a space follow standard URL query decoding.

## Explicitly unsupported

- Embedded resources, select aliases, JSON paths, casts, aggregate expressions, full-text search,
  pattern/range/array operators, order on related resources, and request range headers.

## Security contract

- The root table and every referenced visible column must exist in `SchemaManifest`.
- Parser limits bound decoded URL size, boolean nesting, AST nodes, and list/order/select sizes.
- Malformed percent encoding, invalid grammar, unsupported syntax, invalid identifiers, and limits
  produce stable `QueryAstError` codes.
- Values remain typed data in the AST. The later SQL compiler must bind every value and resolve all
  identifiers from this AST and the manifest.

PostgREST semantics were studied from release `v14.16` (`673bbbf291d5a3b6bda65cf5cf7c340f858a0531`),
MIT. No PostgREST code or tests are copied or vendored.
