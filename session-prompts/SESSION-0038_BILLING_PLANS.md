# SESSION-0038: Billing plans и subscriptions

## Цель
Реализовать Free, Default, Extended, Pro и Enterprise entitlements с безопасным subscription lifecycle.

## Зависимости
- SESSION-0037.

## Upstream Sources
- `https://github.com/stripe/stripe-node`.
- Клонировать/pin stable release, проверить MIT и использовать официальный SDK/webhook verification.

## Scope
- Product/price mapping, checkout, portal, subscription webhooks и entitlement transitions.
- Upgrade/downgrade/cancel, grace period и failed payment behavior.
- Enterprise manual contract entitlement path.

## Out of Scope
- Tax/accounting platform и reseller billing.

## Acceptance Criteria
1. Webhook retry/order не создает неверный plan.
2. Entitlement меняется только из verified billing event/admin contract.
3. Downgrade не удаляет данные автоматически.

## Security
- Webhook signature, replay protection, least Stripe permissions, no card data storage.

## Tests
- Stripe fixture/webhook lifecycle, out-of-order, duplicate и failure tests.

## Deliverables
- Billing service/Studio screens, tests, provenance и Session Log.
