# SESSION-0026: Broadcast и Presence

## Цель
Добавить ephemeral Broadcast и Presence channels отдельно от database changes.

## Зависимости
- SESSION-0025.

## Upstream Sources
- Pinned `supabase/realtime` Broadcast/Presence implementation и protocol tests.
- Адаптировать contracts/algorithms; не переносить unnecessary Postgres code.

## Scope
- Broadcast messages, presence join/leave/state sync и channel policies.
- Per-message/connection limits и multi-instance coordination abstraction.

## Out of Scope
- Global multi-region deployment.

## Acceptance Criteria
1. Authorized members видят consistent presence state.
2. Broadcast ограничен channel policy и quotas.
3. Disconnect очищает presence через deterministic timeout.

## Security
- Payload limits, impersonation prevention, tenant/channel isolation.

## Tests
- Multi-client state, reconnect, stale presence и abuse/load tests.

## Deliverables
- Broadcast/Presence feature, tests и Session Log.
