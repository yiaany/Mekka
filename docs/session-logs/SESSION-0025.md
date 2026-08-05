# SESSION-0025: Realtime subscriptions

## Результат
COMPLETED

## Что сделано
- Добавлен WebSocket endpoint `/realtime/v1/websocket` с Phoenix JSON framing, `phx_join`, `phx_leave`, `phx_reply`, heartbeat и refresh через `access_token`.
- Реализованы authenticated table-change subscriptions с explicit `public` schema/table/event binding и deny-by-default channel authorization.
- Добавлен per-subscriber policy evaluation по полному old/new row snapshot с projection только разрешенных полей.
- Добавлены resume cursor, stable `event_id`, explicit `mekka_ack` и at-least-once replay: unacknowledged event повторяется после reconnect, retention/migration gap требует resync.
- Добавлены bounded unacked event/byte buffers, Bun transport backpressure handling, slow-consumer close и global/tenant/channel/subscription quotas.
- Добавлены authentication/heartbeat deadlines и повторное разрешение project/policy source перед delivery, чтобы долгоживущее соединение не сохраняло устаревшую policy closure.
- Добавлена append-only `_mekka_realtime_policy_events`, записываемая атомарно с changefeed event. Existing journal не изменяется через запрещенный `ALTER`; legacy event без policy snapshot fail closed с `CHANGEFEED_RESYNC_REQUIRED`.
- Добавлены unit/security tests и реальный Elysia/Bun WebSocket integration test.
- Добавлена protocol compatibility matrix.

## Upstream
- `https://github.com/supabase/realtime`, tag `v2.123.4`, commit `177793a9d439d39277a93fbd974ca387d78c3699`, Apache-2.0. Approved clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\realtime-v2.123.4`.
- Изучены `user_socket.ex`, join/config/postgres-change payloads, `realtime_channel.ex` и `postgres_changes_test.exs`: connection auth, join shape, event IDs, system replies, quotas и database-change envelope.
- `https://github.com/supabase/supabase-js`, tag `v2.110.9`, annotated tag object `6c7b338cf576e508ab61d4de3fc6228f822f8e28`, commit `31dc1b0f4e9b21adb056cb799a2702bf1484919f`, MIT. Clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-js-v2.110.9`.
- Изучены `RealtimeClient.ts`, `RealtimeChannel.ts`, Phoenix serializer/adapter и realtime client tests: JSON array framing, heartbeat, auth refresh, join/leave replies, binding matching и bounded client push buffer.
- Upstream source не копировался и не vendor-ился; PostgreSQL WAL/CDC runtime не адаптировался. Дополнительные LICENSE/NOTICE files в product tree не требуются.

## Архитектурные решения
- Authentication остается injected control-plane boundary. Реализация обязана вернуть уже проверенный JWT context с exact issuer/audience, expiry и полным tenant tuple; gateway повторно связывает context с resolved project/source.
- Policy snapshot хранится отдельно от public writer-minimized envelope. Это позволяет проверять event от имени каждого subscriber и не раскрывать predicate fields в WebSocket payload.
- Separate companion table выбран вместо изменения persisted journal schema: `StorageAdapter` намеренно запрещает public `ALTER`/`PRAGMA`, а legacy rows без snapshot нельзя авторизовать догадкой.
- Cursor продвигается для клиента только explicit acknowledgement. Policy-denied/non-matching events безопасно пропускаются внутри connection cursor; если есть pending authorized event, reconnect остается на последнем acknowledged cursor и получает duplicate, а не silent gap.
- Slow consumer изолируется per connection/channel bounded buffer. Закрытие одного tenant connection не останавливает delivery подтверждающему соседу.
- Protocol намеренно partial: знакомый Phoenix/Supabase `postgres_changes` envelope сохранен, но Mekka resume/ack является явным extension, а неподдерживаемые filters/select/Broadcast/Presence отклоняются.

## Измененные файлы
- `apps/gateway/src/app.ts`: realtime route integration и transactional full policy snapshots для REST mutations.
- `apps/gateway/src/realtime.ts`: Elysia WebSocket endpoint, project resolution и policy projection.
- `apps/gateway/test/gateway.test.ts`: realtime dependency fixture.
- `apps/gateway/test/storage.test.ts`: realtime dependency fixture для multi-project gateway.
- `apps/gateway/test/realtime.test.ts`: реальный WebSocket lifecycle integration test.
- `packages/realtime-core/src/index.ts`: companion policy journal и trusted delivery read contract.
- `packages/realtime-core/src/subscriptions.ts`: connection/channel lifecycle, cursor/ack, policy source, quotas, backpressure и expiry.
- `packages/realtime-core/test/realtime-core.test.ts`: legacy migration/resync regression.
- `packages/realtime-core/test/subscriptions.test.ts`: policy, reconnect/duplicate, wrong tenant, expiry, slow consumer и quota tests.
- `packages/realtime-core/package.json`: explicit `./subscriptions` package export.
- `packages/realtime-core/README.md`: delivery/security semantics и upstream provenance.
- `docs/realtime-protocol-matrix.md`: supported/deviation/unsupported matrix.
- `package.json`: realtime integration/security tests включены в root suite.

## Безопасность
- JWT/token передается только в WebSocket message, не URL; malformed/expired token закрывается без stack trace.
- Только authenticated user actor может join; actor и полный tenant tuple нельзя сменить через второй channel или token refresh.
- Resolved source обязан совпадать по `organization_id/project_id/environment_id/branch_id/generation`; mismatch fail closed.
- Channel разрешает только manifest table с select policy; wildcard schema/table, filters и select override отклоняются.
- Каждое old/new состояние повторно проверяется policy engine от имени subscriber; hidden predicate fields не отправляются клиенту.
- Legacy event без trusted policy snapshot и cursor ниже retention floor требуют explicit resync, а не silent skip.
- Message size, unauthenticated lifetime, heartbeat, connections, tenant connections, channels, subscriptions, unacked events и bytes ограничены.
- Backpressure/dropped send и slow consumer закрывают только соответствующее соединение; noisy-neighbor regression подтверждает продолжение delivery другому tenant.
- SQL статичен, tenant tuple и records передаются bound parameters; public arbitrary SQL не добавлен.

## Проверки
- `bun test packages/realtime-core/test/realtime-core.test.ts packages/realtime-core/test/subscriptions.test.ts apps/gateway/test/realtime.test.ts`: PASSED, 11 tests, 33 assertions.
- `bun run check`: PASSED, format check, lint, typecheck, 134 tests/685 assertions, build и health smoke.
- `git diff --check`: PASSED.
- `corepack pnpm install --frozen-lockfile` в `supabase-js-v2.110.9`: PASSED.
- `corepack pnpm --filter @supabase/realtime-js exec vitest run test/RealtimeChannel.postgres.test.ts test/RealtimeClient.transport.test.ts test/RealtimeClient.auth.test.ts`: PASSED, 51 tests.
- `corepack pnpm --filter @supabase/realtime-js build`: PASSED.
- `elixir --version`: FAILED, Elixir отсутствует в окружении; upstream Realtime ExUnit suite не запускался. Upstream source не используется, извлеченные contracts покрыты нашими TypeScript/WebSocket tests.
- `corepack pnpm audit --prod` в upstream Supabase JS clone: FAILED, 1 Moderate в `packages/core/realtime-js/example -> next -> postcss <=8.5.22`. Example dependency не добавлена в продукт и upstream source/dependencies не копировались.
- `bun pm scan`: FAILED, repository не настраивает Bun security scanner в `bunfig.toml`.

## Совместимость
- Поддержано: Phoenix JSON v2-style array framing, heartbeat, join/leave/reply, access-token refresh, `postgres_changes` event/schema/table bindings и Supabase-like event envelope.
- Mekka extension: join `cursor`, explicit `mekka_ack`, close `4009 resync_required`, stable `event_id` и at-least-once duplicate semantics.
- Unsupported: database `filter`, column `select`, wildcard schema/table, Broadcast, Presence, binary serializer и PostgreSQL WAL/logical replication.
- SQLite transactional outbox semantics не выдаются за полную Supabase/PostgreSQL Realtime parity.

## Ограничения и риски
- Connection quotas process-local для одного gateway instance; distributed quota coordination и global admission control остаются будущим control-plane/data-plane slice.
- Direct SQL и trusted writers, не интегрированные с `appendChangeEvents`, не создают realtime events.
- Policy snapshot увеличивает размер project database; scheduled retention/metering остается вне scope.
- Клиент обязан сохранять cursor после успешной обработки и deduplicate по `event_id`; native SDK helper для этого contract еще не добавлен.
- Full Supabase protocol parity, filters/select, Broadcast, Presence и binary transport намеренно отсутствуют.

## Следующая рекомендуемая сессия
- `SESSION-0026`: Functions runtime foundation с immutable artifact, sandbox limits и tenant-bound invocation routing.
