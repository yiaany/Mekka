# SESSION-0026: Broadcast и Presence

## Результат
COMPLETED

## Что сделано
- Существующий Phoenix/WebSocket gateway расширен ephemeral Broadcast и Presence без смешивания с database changefeed.
- Broadcast поддерживает channel event, JSON object payload, `self`, `ack`, отдельные read/write policies и bounded payload/rate limits.
- Presence поддерживает `presence_state`, `presence_diff`, `track`, `untrack`, несколько metas одного actor после reconnect и deterministic lease cleanup stale connection.
- Presence key всегда привязан сервером к authenticated actor. Client-defined чужой key и reserved identity fields отклоняются.
- Добавлен process-wide `RealtimeChannelCoordinator` для fanout, presence state и leases внутри одного Bun runtime; изоляция нескольких gateway objects проверена общим in-memory coordinator.
- Project resource model расширена explicit `realtimeChannels`: неизвестный channel и actor вне membership deny by default.
- Добавлены unit/security/load tests и реальный WebSocket integration test с database changes, Presence и Broadcast на одном channel.
- Обновлены protocol compatibility matrix, package exports, root test suite и realtime documentation.

## Upstream
- Repository: `https://github.com/supabase/realtime`.
- Tag: `v2.123.4`; commit: `177793a9d439d39277a93fbd974ca387d78c3699`; текущий remote `HEAD` на момент проверки также указывал на этот commit.
- License: Apache-2.0, проверена в upstream `LICENSE`.
- Approved clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\realtime-v2.123.4`.
- Изучены `realtime_channel.ex`, `presence_handler.ex`, Broadcast/Presence join payload schemas, `broadcast_test.exs`, `presence_test.exs`, distributed channel tests и policy/rate-limit tests.
- Дополнительно проверен ранее pinned `supabase/supabase-js` `v2.110.9`, commit `31dc1b0f4e9b21adb056cb799a2702bf1484919f`, MIT: Presence adapter и Realtime channel messaging contracts.
- Upstream source и dependencies не копировались и не vendor-ились; адаптированы только protocol shapes, self/ack semantics, state/diff algorithm ideas, policy gates и test scenarios. Дополнительные LICENSE/NOTICE files в product tree не требуются.

## Архитектурные решения
- Broadcast/Presence используют тот же authenticated channel lifecycle, tenant tuple и token binding, что SESSION-0025; отдельный transport не создавался.
- Channel authorization является explicit project resource: exact channel name, membership и независимые `broadcast.read/write`, `presence.read/write`.
- Presence ownership задается `connection_id + topic`, а public key задается actor ID. Поэтому один actor может безопасно reconnect с новой meta, но не может выдать себя за другого actor.
- Graceful `untrack`/`phx_leave` удаляет presence сразу. Неожиданный disconnect не доверяет локальному cleanup: lease остается до точного deadline и удаляется coordinator sweep, что покрывает потерю gateway instance.
- Coordinator остается внутренней process-wide границей одного Bun runtime. Внешний Redis/NATS/PostgreSQL coordination layer не требуется и не входит в целевую lightweight topology.
- Database subscription-only channels остаются совместимыми: отсутствие ephemeral channel rule дает им deny для Broadcast/Presence, но не ломает разрешенный `postgres_changes` join.

## Измененные файлы
- `packages/realtime-core/src/channels.ts`: coordinator contract, in-memory fanout, grouped presence state, track/update/untrack и lease sweep.
- `packages/realtime-core/src/subscriptions.ts`: Broadcast/Presence protocol, channel policies, actor binding, quotas, coordinator integration и cleanup lifecycle.
- `packages/realtime-core/test/channels.test.ts`: несколько gateway objects в одном runtime, policy, tenant, impersonation, reconnect, stale presence и abuse/load regressions.
- `packages/realtime-core/test/subscriptions.test.ts`: explicit deny ephemeral policy для existing database subscription fixture.
- `packages/realtime-core/package.json`: export `./channels`.
- `packages/realtime-core/README.md`: delivery, security, coordination и upstream semantics.
- `apps/gateway/src/realtime.ts`: project channel rules и source authorization adapter.
- `apps/gateway/src/app.ts`: realtime channel rules в общей project resource model.
- `apps/gateway/test/realtime.test.ts`: реальный WebSocket Broadcast/Presence smoke в существующем channel lifecycle.
- `apps/gateway/test/gateway.test.ts`, `apps/gateway/test/storage.test.ts`: explicit empty realtime policy fixtures.
- `docs/realtime-protocol-matrix.md`: Broadcast/Presence compatibility и deviations.
- `package.json`: новый security/coordination test suite включен в root tests.
- `docs/session-logs/SESSION-0026.md`: этот журнал.

## Безопасность
- Проверяется полный tenant tuple через существующую authentication/source binding; coordinator scope включает tenant generation и exact channel.
- Unknown channel, non-member actor и отсутствующая policy отклоняются без public fallback.
- Broadcast и Presence имеют независимые read/write permissions; read-only member не может publish/track, write-only member не получает payload/state.
- Presence key и `actor_id` формируются сервером; custom чужой key, `actor_id`, `phx_ref` и `presence_ref` в payload отклоняются.
- Broadcast/Presence принимают только bounded JSON object с finite numbers, ограниченной depth/cardinality и размером.
- Ограничены per-client message rate, channel presence cardinality, connection/channel counts и transport message size.
- Broadcast self-delivery выполняется только при explicit `self`; tenant/channel fanout не использует пользовательский routing key.
- Policy source повторно разрешается на heartbeat/tick/token refresh. Revoked read permission закрывает channel fail closed; write permission обновляется до следующей mutation.
- Stale presence не остается бессрочно после process/network loss: lease удаляется при `expiresAt <= now` и публикует deterministic leave diff.
- Новые dependencies и arbitrary SQL не добавлены; upstream code не копировался.

## Проверки
- `bun test --timeout 5000 packages/realtime-core/test/realtime-core.test.ts packages/realtime-core/test/subscriptions.test.ts packages/realtime-core/test/channels.test.ts apps/gateway/test/realtime.test.ts`: PASSED, 15 tests, 51 assertions на основном targeted run.
- `bun test packages/realtime-core/test/channels.test.ts`: PASSED, 5 tests, 24 assertions после финального independent policy regression.
- `bun run check`: PASSED, format check, lint, typecheck, 139 tests/711 assertions, build и health smoke.
- `git diff --check`: PASSED.
- `corepack pnpm --filter @supabase/realtime-js exec vitest run test/phoenix/presenceAdapter.test.ts test/RealtimeChannel.messaging.test.ts`: PASSED, 58 upstream client contract tests.
- Upstream Realtime ExUnit suite не запускался: для релевантных integration tests требуется отдельный upstream PostgreSQL test environment. Elixir 1.19.5/OTP 28 установлен только как внешний test toolchain и не входит в runtime/dependencies продукта. Адаптированные contracts покрыты TypeScript unit и real WebSocket integration tests.

## Совместимость
- Поддержано: Phoenix JSON channel messages, Broadcast event/payload, `self`, `ack`, Presence `presence_state`, `presence_diff`, `track`, `untrack` и Supabase-compatible grouped `metas` shape.
- Mekka security deviation: Presence key всегда authenticated actor ID; произвольный Supabase Presence key не поддерживается, чтобы исключить impersonation без отдельной trusted key policy.
- Mekka lifecycle deviation: unexpected disconnect публикует leave после deterministic lease timeout, а не зависит от немедленного process-local cleanup.
- Unsupported: Broadcast replay, REST Broadcast endpoint, binary payload/serializer, public unauthenticated channels и global multi-region deployment.
- Broadcast/Presence остаются ephemeral и не получают changefeed cursor/replay guarantees.

## Ограничения и риски
- Runtime намеренно single-process Bun. Горизонтальная multi-process и multi-region координация находится вне scope и не является требованием текущей topology.
- Presence lease renewal и quotas process-wide внутри одного Bun runtime; они сбрасываются при полном restart процесса вместе с ephemeral Presence/Broadcast state.
- Billing metering и долговременная агрегация usage остаются отдельным control-plane slice, но не требуют Redis в realtime runtime.
- Presence state ограничен transport message size: слишком большой initial state закрывает consumer вместо partial state, чтобы не выдавать неполную картину.
- Upstream Elixir integration tests не запускались из-за отсутствующего upstream PostgreSQL test environment; это не влияет на runtime, поскольку upstream Elixir code не используется.

## Следующая рекомендуемая сессия
- `SESSION-0027`: lifecycle preview branches со snapshot lineage, generation binding и безопасным cleanup.
