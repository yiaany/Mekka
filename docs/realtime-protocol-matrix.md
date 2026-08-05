# Realtime protocol matrix

Reference versions:

- `supabase/realtime` `v2.123.4`, commit `177793a9d439d39277a93fbd974ca387d78c3699`, Apache-2.0.
- `supabase/supabase-js` `v2.110.9`, commit `31dc1b0f4e9b21adb056cb799a2702bf1484919f`, MIT.

| Capability | Mekka v1 | Supabase reference | Notes |
| --- | --- | --- | --- |
| WebSocket endpoint | Supported | Supported | `/realtime/v1/websocket`, Phoenix JSON array framing. |
| `phx_join` / `phx_leave` / `phx_reply` | Supported | Supported | One connection may join bounded database-change and ephemeral channels. |
| Heartbeat | Supported | Supported | `phoenix` / `heartbeat`; stale and unauthenticated sockets are closed. |
| Access token in join | Supported | Supported | Mekka requires project JWT verification with exact audience and full tenant tuple in the injected authenticator. |
| Token refresh event | Supported | Supported | `access_token`; actor and tenant binding cannot change on an existing connection. |
| `postgres_changes` event/schema/table binding | Partial | Supported | `public` and explicit table only; event is `*`, `INSERT`, `UPDATE` or `DELETE`. |
| Row policy enforcement | Supported | Supported with PostgreSQL RLS | Mekka re-evaluates its policy engine per old/new row snapshot and projects allowed fields per subscriber. |
| Resume cursor | Mekka extension | Not equivalent | Join `cursor` plus `mekka_ack` provides explicit at-least-once resume and duplicate detection by `event_id`. |
| Retention gap | Supported | Different CDC model | Sends `system` error and closes with `4009 resync_required`; never silently skips history. |
| Bounded slow consumer | Supported | Implementation-specific | Bounded unacknowledged events/bytes plus Bun transport backpressure; close `1013 slow_consumer`. |
| Connection/channel quotas | Supported | Supported | Global, tenant, channel and subscription caps are enforced independently. |
| Database filters | Unsupported | Supported | `filter` is rejected instead of applying different semantics. |
| Column `select` | Unsupported | Supported | Rejected; policy field projection remains mandatory. |
| Wildcard schema/table | Unsupported | Supported in subsets | Explicit `public` schema and manifest table are required. |
| Broadcast | Partial | Supported | WebSocket `broadcast`, exact event, JSON object payload, `self` and `ack`; channel read/write policy, payload/rate quotas and tenant isolation are enforced. Replay, REST broadcast and binary payloads are unsupported. |
| Presence | Partial | Supported | `presence_state`, `presence_diff`, `track` and `untrack`; server-bound actor key, read/write policy, cardinality/rate/payload limits and deterministic stale lease cleanup. Custom/impersonated keys are rejected. |
| Process-wide ephemeral coordination | Supported | Different topology | `RealtimeChannelCoordinator` provides fanout, state and leases inside one Bun process. External Redis/NATS/PostgreSQL coordination is intentionally not required. |
| Binary Phoenix serializer | Unsupported | Supported | JSON framing only. |
| PostgreSQL WAL/logical replication | Unsupported | Supported | Mekka uses the SQLite transactional outbox from SESSION-0024. |

## Client requirements

Clients must persist a cursor only after processing every event through that cursor. An unacknowledged event may be delivered again after reconnect. `event_id` is stable and must be used for idempotent handling.
