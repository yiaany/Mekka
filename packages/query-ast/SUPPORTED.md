# Query AST Supported Matrix

| Query feature | Status | Notes |
| --- | --- | --- |
| `select=*` | Supported | Default when omitted. |
| `select=id,name` | Supported | Visible root columns only. |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | Supported | Values remain strings for the compiler to bind/coerce. |
| `in.(1,2)` | Supported | Quoted values and backslash escaping supported. |
| `is.null`, `is.not_null`, `is.true`, `is.false`, `is.unknown` | Supported | Exact lowercase tokens. |
| `and=(...)`, `or=(...)` | Supported | Nested groups and `not.` bounded by parser depth. |
| `order`, `limit`, `offset` | Supported | Root resource only. |
| `like`, `ilike`, regex, FTS | Unsupported | Deferred; SQLite compatibility must be defined first. |
| Array/range operators and modifiers | Unsupported | PostgreSQL-specific semantics are not claimed. |
| Embedded resources, aliases, JSON paths, casts, aggregates | Unsupported | Out of scope for this session. |
| Range request headers | Unsupported | HTTP adapter concern, deferred. |
