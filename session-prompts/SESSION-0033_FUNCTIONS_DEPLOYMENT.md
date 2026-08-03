# SESSION-0033: Functions deployment lifecycle

## Цель
Дать пользователю deploy/invoke Functions, secret references, cron и logs.

## Зависимости
- SESSION-0032, SESSION-0037 если metering уже реализован; иначе добавить временный hard quota без billing coupling.

## Upstream Sources
- Pinned `supabase/edge-runtime` integration из SESSION-0032.
- Не менять upstream commit без отдельной совместимости/лицензионной проверки.

## Scope
- Content-addressed build/deployment artifact и version rollback.
- HTTP invocation, ephemeral secret injection, logs/traces.
- Durable cron/webhook jobs и bounded retries.

## Out of Scope
- Marketplace, arbitrary native dependencies и multi-region scheduler.

## Acceptance Criteria
1. Deploy создает immutable version; rollback переключает version.
2. Secret не появляется в bundle/logs.
3. Cron retry идемпотентен и имеет dead-letter state.

## Security
- Tenant quotas, outbound policy, signed artifacts и audit.

## Tests
- Deploy/invoke/rollback, secret redaction, timeout, cron retry и isolation.

## Deliverables
- Functions service/Studio screen, tests и Session Log.
