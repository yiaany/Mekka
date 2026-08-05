# @mekka/realtime-core

Transactional SQLite change journal for trusted writes.

## Semantics

- The gateway writes business rows, idempotency state and change events in one `StorageAdapter.transaction`.
- Events become visible only after that transaction commits. A rollback removes both the row change and its journal entries.
- Delivery is at least once: reading does not acknowledge or delete events. Consumers persist `nextCursor` only after successful handling and deduplicate by stable `eventId`.
- Cursor order is authoritative within a tenant generation. `transaction.id` and `transaction.sequence` preserve grouping and row order for bulk mutations.
- Retention atomically deletes events and advances an explicit per-tenant floor. Reading an older cursor throws `CHANGEFEED_RESYNC_REQUIRED`; the consumer must rebuild state before resubscribing.
- Journal rows include the full tenant tuple. Every read and prune query binds all tenant components, including `generation`.
- `record` and `oldRecord` remain policy-minimized for the writer-facing journal contract. A separate transactional policy snapshot stores all manifest-visible fields so each subscriber can be authorized as its own actor at delivery time.
- Policy snapshots use `_mekka_realtime_policy_events` instead of altering the existing journal. Legacy events without a companion snapshot fail with `CHANGEFEED_RESYNC_REQUIRED`; they are never delivered with guessed authorization.

## WebSocket subscriptions

- `createRealtimeSubscriptionGateway` implements Phoenix JSON messages for `phx_join`, `phx_leave`, `phx_reply`, heartbeat and `postgres_changes` delivery.
- A join carries the authenticated access token, table subscriptions and an optional resume cursor. The authenticator must perform strict issuer, audience, expiry and full tenant tuple verification before returning a `TenantContext`.
- Delivery is at least once. Clients deduplicate by `event_id` and send `mekka_ack` with the highest processed cursor. Reconnect uses the last acknowledged cursor; unacknowledged events are replayed.
- Per-connection unacknowledged event/byte buffers are bounded. A client that remains full while newer events exist is closed with `1013 slow_consumer`; other tenants and connections continue independently.
- Connection, per-tenant connection, channel, subscription, payload, heartbeat and authentication deadlines are bounded.
- Broadcast uses the same authenticated channel, exact tenant/channel scope and separate read/write policy. Payload size, event shape, per-client rate and presence cardinality are bounded.
- Presence keys are server-bound to the authenticated actor. Reserved identity fields cannot be supplied by the client; each connection/channel owns one leased meta entry.
- Presence sends `presence_state` and `presence_diff` using the Phoenix/Supabase shape. Graceful untrack/leave is immediate; disconnect leases expire after a deterministic timeout so a lost gateway instance cannot leave permanent ghost state.
- `RealtimeChannelCoordinator` is a process-wide boundary for one Bun runtime. The in-memory implementation is the production topology for this lightweight single-process service; Redis, NATS and PostgreSQL coordination are not required.
- `filter`, `select`, wildcard schema, Broadcast replay/REST endpoint and binary payloads remain explicitly unsupported.

Direct SQL outside the trusted gateway is intentionally not observed.

## Upstream reference

Supabase Realtime `v2.123.4`, commit `177793a9d439d39277a93fbd974ca387d78c3699`, Apache-2.0, was reviewed for the database-change envelope, join/auth lifecycle, Broadcast self/ack behavior, Presence state/diff/track/untrack, policy gates, quotas and distributed tests. Supabase JS `v2.110.9`, tag commit `31dc1b0f4e9b21adb056cb799a2702bf1484919f`, MIT, was reviewed for Phoenix JSON framing, heartbeat, channel config and Presence adapter semantics. No upstream source was copied.
