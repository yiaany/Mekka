# SESSION-0024: SQLite Realtime changefeed

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/realtime-core` с versioned database-change envelope для `INSERT`, `UPDATE` и `DELETE`.
- Реализован transactional outbox `_mekka_realtime_events`: event journal записывается в той же SQLite transaction, что business mutation и idempotency record gateway.
- Добавлены стабильный `eventId`, monotonic cursor, transaction ID, sequence внутри bulk transaction и occurrence timestamp.
- Реализовано at-least-once чтение без destructive acknowledgement: повторное чтение cursor возвращает те же events, а consumer может deduplicate по `eventId`.
- Реализован атомарный retention prune с per-tenant floor; запрос cursor ниже floor возвращает `CHANGEFEED_RESYNC_REQUIRED`.
- REST insert/update/delete теперь создают policy-minimized events. Idempotent replay не создает duplicate event, failed/rolled-back bulk mutation не оставляет journal rows.
- Добавлена документация semantics и regression tests для commit/rollback, retry, ordering, retention failure и cross-tenant isolation.

## Upstream
- Repository: `https://github.com/supabase/realtime`.
- Tag: `v2.123.4`; commit: `177793a9d439d39277a93fbd974ca387d78c3699`; release commit от 5 августа 2026 года.
- License: Apache-2.0.
- Временный shallow clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\realtime-v2.123.4`.
- Изучены `lib/realtime_web/channels/payloads/postgres_change.ex`, `lib/realtime_web/channels/realtime_channel.ex` и `test/integration/rt_channel/postgres_changes_test.exs`: event/schema/table/filter subscription shape, `INSERT`/`UPDATE`/`DELETE` envelope, old/new record и ordering expectations.
- Upstream source, PostgreSQL CDC, replication slots, WAL poller и channel runtime не копировались и не vendor-ились; LICENSE/NOTICE files в product tree не требуются.

## Архитектурные решения
- Journal живет рядом с project database и коммитится одной `StorageAdapter.transaction`; отдельная post-commit publish попытка создавала бы окно потери event после committed write.
- Cursor глобально monotonic в SQLite file, но consumer contract и state scoped полным tenant tuple. Сравнение cursors допустимо только внутри одной tenant generation.
- Delivery намеренно at-least-once: read не изменяет state, consumer сохраняет cursor только после обработки и deduplicate по stable `eventId`.
- Bulk mutation получает один transaction ID и последовательные номера events в фактическом DML order.
- Retention удаляет rows и продвигает floor атомарно; crash между этими действиями не может скрыть обязательный resync.
- Payload формируется trusted gateway после policy checks и сохраняет только поля, разрешенные select field policy для измененной строки. Binary values кодируются hex, bigint строкой.
- Direct SQL, Storage/Auth internal writes и migration DDL не перехватываются: scope ограничен trusted REST mutation path.

## Измененные файлы
- `packages/realtime-core/src/index.ts`: schema, append/read/prune API, validation, tenant scoping и stable errors.
- `packages/realtime-core/test/realtime-core.test.ts`: transaction, retry, ordering, retention rollback/gap и cross-tenant tests.
- `packages/realtime-core/README.md`: delivery, cursor, retention, security и upstream semantics.
- `packages/realtime-core/package.json`, `packages/realtime-core/tsconfig.json`: workspace package configuration.
- `apps/gateway/src/app.ts`: atomic change event creation для REST mutations и policy-minimized row serialization.
- `apps/gateway/test/gateway.test.ts`: idempotent event, rollback absence, redaction и bulk transaction ordering regressions.
- `apps/gateway/package.json`, `apps/gateway/tsconfig.json`: dependency/reference на `realtime-core`.
- `package.json`, `tsconfig.json`, `bun.lock`: root test, project reference и workspace lock integration.

## Безопасность
- Все journal read, state и retention queries связывают `organization_id`, `project_id`, `environment_id`, `branch_id` и `generation`; cross-tenant test проверяет отсутствие утечки и независимый retention floor.
- Event не виден до commit и исчезает при rollback вместе с business write; failed bulk policy check не оставляет частичный journal.
- Idempotency replay возвращает сохраненный HTTP response до mutation path и не создает второй event.
- Event payload не содержит deny-listed `private_note`; поля выбираются через policy decision, а не из public request field list.
- SQL templates статичны, значения и tenant identity передаются bound parameters; table identifier хранится как значение, не интерполируется в SQL.
- Invalid cursor, malformed record, future cursor и retention outside journal fail closed со stable errors.
- Retention delete и floor update атомарны; regression test предотвращает silent history gap при infrastructure failure.

## Проверки
- `bun install`: PASSED, workspace lock обновлен для `@mekka/realtime-core`.
- `bun install --frozen-lockfile`: PASSED после обновления lockfile.
- `bun run typecheck`: PASSED.
- `bun test packages/realtime-core/test/realtime-core.test.ts`: PASSED, 4 tests.
- `bun test apps/gateway/test/gateway.test.ts`: PASSED, 10 tests.
- `bun run lint`: PASSED.
- `bun run check`: PASSED, format check, lint, typecheck, 127 tests, build и health smoke test.
- `git diff --check`: PASSED.
- `elixir --version`: FAILED, Elixir отсутствует в окружении, поэтому upstream ExUnit/PostgreSQL integration suite не запускался. Upstream code не использован; извлеченные contracts проверены нашими SQLite core/gateway tests.

## Совместимость
- Envelope сохраняет знакомые Supabase Realtime concepts: operation type, table, old/new record и transaction timestamp metadata.
- Это внутренний changefeed contract version `1`, а не WebSocket `postgres_changes` compatibility endpoint.
- Не поддерживаются upstream subscription filters, schema wildcard semantics, WAL/logical replication, Broadcast, Presence и `@supabase/realtime-js` transport.
- SQLite semantics и trusted-path outbox не выдаются за PostgreSQL logical replication parity.

## Ограничения и риски
- Direct SQL outside trusted gateway и writes других modules не создают events; расширение coverage требует явной интеграции каждого trusted writer с тем же transaction boundary.
- `occurredAt` фиксирует начало gateway mutation processing, а не внешний database commit timestamp; ordering определяется cursor и transaction sequence.
- Retention запускается явным trusted API; durable scheduled job, quota/metering и time/size policy находятся вне scope.
- Consumer cursor persistence и WebSocket delivery появятся в следующей session; текущий package предоставляет durable pull boundary.
- Policy predicates могут опираться на поля, которые не входят в select payload. Текущий journal сохраняет только select-allowed поля; subscription authorization должен выполняться до delivery и не рассчитывать на наличие скрытых predicate fields в public event.

## Следующая рекомендуемая сессия
- `SESSION-0025`: tenant-scoped Realtime subscriptions поверх changefeed с authorization, cursor resume, filters и explicit resync flow.
