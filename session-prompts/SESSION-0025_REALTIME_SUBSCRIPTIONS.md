# SESSION-0025: Realtime subscriptions

## Цель
Дать authenticated clients подписку на разрешенные table changes.

## Зависимости
- SESSION-0019, SESSION-0024.

## Upstream Sources
- Pinned `supabase/realtime` protocol/tests и `supabase-js` realtime client behavior.
- При необходимости временно клонировать `https://github.com/supabase/supabase-js` и pin commit.

## Scope
- WebSocket lifecycle, join/leave, heartbeat, resume cursor и bounded buffers.
- Policy-filtered database change subscriptions.
- Backpressure/slow consumer behavior.

## Out of Scope
- Broadcast/Presence и полная Supabase protocol parity.

## Acceptance Criteria
1. Authorized client получает только разрешенные changes.
2. Reconnect/resume не создает silent gap.
3. Slow client ограничивается без деградации других tenants.

## Security
- JWT audience/project binding, channel authorization и connection quotas.

## Tests
- WebSocket integration, reconnect, duplicate, policy, expiry и noisy-neighbor tests.

## Deliverables
- Realtime gateway, tests, protocol matrix и Session Log.
