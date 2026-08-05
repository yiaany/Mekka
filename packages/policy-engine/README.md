# @mekka/policy-engine

Version 1 is a typed, deny-by-default policy boundary for public data operations. It does not grant
direct database access: trusted admin paths remain outside this package.

## Model

- A table holds action-specific rules for `select`, `insert`, `update`, and `delete`.
- Rules are ORed. A matching `using` predicate authorizes an existing row; a matching `check`
  predicate authorizes insert/update input. Update needs both predicates and evaluates `check` on
  the old row merged with the mutation input.
- Predicates currently support bounded `and`/`or` groups and `eq`/`neq` comparison of a visible
  column with the authenticated actor ID or a literal string.
- Field access is allowlisted per matching rule. Explicit deny always wins. Missing policy and
  missing field permission deny the public operation. For insert/update, declared fields must
  exactly match mutation input keys, so a caller cannot hide forbidden values behind a shorter list.

## Runtime and query rewriting

`simulatePolicy` evaluates a concrete row/input. `rewritePolicyQuery` uses the same policy rules to
add an OR row predicate to a validated query AST before SQLite compilation. Update input checks
remain runtime checks, because they apply to the resulting new values rather than persisted rows.

The package is SQLite-neutral and emits no SQL. The caller must carry the full validated
`TenantContext`, use the rewritten AST before SQL execution, and perform mutation checks in the same
transaction as the mutation.
