# Migration Engine

`@mekka/migration-engine` applies a constrained, hash-addressed SQLite DDL artifact through the managed storage transaction boundary.

- Only one allowlisted DDL statement is accepted: `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, table/column rename, `CREATE [UNIQUE] INDEX`, or `DROP TABLE`/`DROP INDEX` with a checkpoint for the current schema.
- Dangerous constructs such as triggers, views, virtual tables, `ATTACH`, `PRAGMA`, `VACUUM`, destructive DDL, and multi-statement input are rejected.
- The migration ledger is internal (`_mekka_migrations`) and records actor, idempotency key, artifact hash, expected schema hash, lifecycle state, and resulting schema hash transactionally.
- Checkpoints use SQLite `VACUUM INTO` through `StorageAdapter.createCheckpoint`; neither backup nor restore copies a live database file. Backup verification uses a schema fingerprint without SQLite's local `schema_version`, which can differ after reconstruction.
- Restore accepts an explicit approved `sourceDirectory` when checkpoint and destination roots differ.
