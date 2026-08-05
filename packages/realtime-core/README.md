# @mekka/realtime-core

Transactional SQLite change journal for trusted writes.

## Semantics

- The gateway writes business rows, idempotency state and change events in one `StorageAdapter.transaction`.
- Events become visible only after that transaction commits. A rollback removes both the row change and its journal entries.
- Delivery is at least once: reading does not acknowledge or delete events. Consumers persist `nextCursor` only after successful handling and deduplicate by stable `eventId`.
- Cursor order is authoritative within a tenant generation. `transaction.id` and `transaction.sequence` preserve grouping and row order for bulk mutations.
- Retention atomically deletes events and advances an explicit per-tenant floor. Reading an older cursor throws `CHANGEFEED_RESYNC_REQUIRED`; the consumer must rebuild state before resubscribing.
- Journal rows include the full tenant tuple. Every read and prune query binds all tenant components, including `generation`.
- `record` and `oldRecord` are policy-minimized by the trusted write path before persistence. The core never reads arbitrary application tables or accepts public SQL.

Direct SQL outside the trusted gateway is intentionally not observed. WebSocket delivery, subscription filters, Broadcast and Presence are outside this package.

## Upstream reference

Supabase Realtime `v2.123.4`, commit `177793a9d439d39277a93fbd974ca387d78c3699`, Apache-2.0, was reviewed for the database-change envelope and subscription tests. No upstream source was copied; PostgreSQL logical replication and channel runtime were not adapted.
