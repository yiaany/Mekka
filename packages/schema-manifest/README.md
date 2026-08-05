# @mekka/schema-manifest

`@mekka/schema-manifest` reads SQLite catalog metadata into a deterministic public schema contract for
the API, Studio, MCP and later query validation.

## Contract

- Manifest format is versioned by `schemaManifestFormatVersion`.
- SQLite `3.37.0` or later is required because `PRAGMA table_list` was added in that version.
- The SHA-256 hash covers canonical JSON containing the format version, SQLite `schema_version` and
  deterministically ordered tables, columns, foreign keys and indexes.
- `createSchemaManifestCache` compares SQLite `schema_version` before each return. Supported DDL
  invalidates the cached manifest automatically; callers can also call `invalidate()` after an
  out-of-band schema lifecycle event.
- Tables named `sqlite_*` and `_mekka_*` are omitted. The internal prefix is configurable only at
  manifest construction time, not from an untrusted request.
- Catalog reads use fixed table-valued PRAGMA queries with bound table/index names. No data rows,
  secrets, SQL text, or caller-composed identifiers are included in the manifest.

## SQLite provenance

The implementation follows the official SQLite documentation for `PRAGMA table_list`,
`table_xinfo`, `foreign_key_list`, `index_list`, `index_xinfo`, and `schema_version`. No upstream
code is copied or vendored.
