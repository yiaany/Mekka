# Branch engine capabilities

Verified on 5 August 2026 for SESSION-0027.

| Engine | Status | Snapshot/branch capability | Product decision |
|---|---|---|---|
| Local Bun SQLite | Implemented | One `VACUUM INTO` source snapshot creates the preview; user rows are scrubbed, then the retained immutable checkpoint is rebuilt from the schema-only preview before Auth or credential issuance | Supported by `@mekka/branch-core` |
| libSQL | Upstream verified | Replication snapshots and SQLite online backup primitives exist; no product-level branch lifecycle was inferred | Remote adapter remains unsupported until conformance tests exist |
| Turso Database | Upstream verified | In-process SQLite-compatible engine; repository does not establish managed cloud branching semantics | No cloud capability is inferred from the engine |
| Turso Cloud Platform API | Upstream verified | Official API supports creating a database from another database and issuing a database token | Capability recorded, adapter not implemented or simulated in this session |

Upstream pins:

- `tursodatabase/libsql`: commit `6f451a1fabacbcbc9960b232b4c1605a5021979b`, MIT.
- `tursodatabase/turso`: commit `bc62e48718d5cfe8388deb57f9de5fa9d572c3ae`, MIT.
- Turso Platform database creation: `https://docs.turso.tech/api-reference/databases/create`.
- Turso database token issuance: `https://docs.turso.tech/api-reference/databases/create-token`.

No upstream source was copied into the product tree. The implementation uses existing local storage and migration contracts.
