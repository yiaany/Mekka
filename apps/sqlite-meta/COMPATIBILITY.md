# SQLite Meta Compatibility Matrix

| Resource | Supported | Notes |
| --- | --- | --- |
| `GET /tables`, `GET /columns`, `GET /indexes` | Yes | Requires `schema:read` or `schema:manage`; returns stable SQLite-focused DTOs derived from `SchemaManifest`, not raw PRAGMA rows. |
| `GET /schema/health` | Yes | Returns manifest format, SQLite schema version and the current schema hash for optimistic concurrency. |
| `POST /tables` | Yes | `INTEGER`, `TEXT`, `REAL`, `BLOB`, `NUMERIC`; primary keys are set at table creation. |
| `PATCH /tables/{table}` | Yes | Table rename only. |
| `DELETE /tables/{table}` | Yes | Requires the current schema hash and creates a verified checkpoint before `DROP TABLE`. |
| `POST /columns` | Yes | Adds nullable columns only. |
| `PATCH /columns/{table}/{column}` | Yes | Column rename only. |
| `POST /indexes` | Yes | Single-table ordinary or unique indexes over exposed columns. |
| `GET /rows/{table}` | Yes | Requires `data:read`; manifest-backed table/column identifiers, bounded pagination (max 200) and optional escaped primary-key filter. |
| `POST/PATCH/DELETE /rows/{table}` | Yes | Requires `data:write`, an idempotency key and an explicit key for update/delete. Values are restricted to strings, numbers and null. |
| `POST /sql` | Limited | Read-only `SELECT ... LIMIT <= 200` requires `data:read`; `INSERT/UPDATE/DELETE` additionally require `sql:execute`. A single statement only; DDL, PRAGMA, transactions, system tables and unknown tables are denied. Audit stores statement hash and row count, never SQL text or results. |
| PostgreSQL schema, comments, enum/uuid/json types, ownership, RLS, tablespaces | No | Explicit `unsupported` or validation response; SQLite semantics are not represented as PostgreSQL parity. |
| Drop column/index, alter type/default/nullability, composite changes to an existing PK | No | Deferred because the constrained migration engine does not permit table rebuilds in this slice. |
| Triggers, views, generated columns, virtual tables, extensions, arbitrary DDL SQL | No | Explicitly out of scope and blocked by the SQL allowlist. |
