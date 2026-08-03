# SESSION-0037: Metering, quotas и entitlements

## Цель
Измерять billable usage и принудительно применять plan limits без cross-tenant ошибок.

## Зависимости
- SESSION-0002 и работающие Database/Storage/Realtime paths.

## Upstream Sources
- Не требуется; не добавлять billing vendor в usage core.

## Scope
- Append-only usage events, aggregation/reconciliation и entitlement snapshot.
- Limits для requests, storage, egress, realtime connections и function compute.
- Hard/soft limit behavior и usage API/Studio summary.

## Out of Scope
- Payment checkout и invoices.

## Acceptance Criteria
1. Usage retry не считается дважды.
2. Quota enforcement работает в каждом включенном module.
3. Reconciliation находит расхождения raw/aggregated usage.

## Security
- Signed/internal events, tenant tuple, anti-tamper и no user-controlled price fields.

## Tests
- Idempotency, concurrency, quota boundary, clock/window и reconciliation tests.

## Deliverables
- Metering service, entitlement API, tests и Session Log.
