# SESSION-0042: Free tier auto-suspend и abuse controls

## Цель
Дать много бесплатных projects без неограниченного active compute и abuse.

## Зависимости
- SESSION-0037, SESSION-0038, SESSION-0041.

## Upstream Sources
- Не требуется; provider-specific autosuspend API документировать отдельно.

## Scope
- Dormant/pooled/warm state machine, idle detection и safe wake-up.
- Shared Free budgets для storage, egress, requests, realtime и functions.
- Signup/email/SMS/mining/spam abuse signals и throttling.

## Out of Scope
- ML fraud platform и permanent account bans без review path.

## Acceptance Criteria
1. Dormant project восстанавливается без потери данных.
2. 100 created projects не означают 100 active workers.
3. Abuse не влияет на paid tenants.

## Security
- No tenant starvation, bypass-resistant counters, privacy-limited signals.

## Tests
- Suspend/wake races, quota bypass, burst/noisy-neighbor и abuse fixtures.

## Deliverables
- Lifecycle/abuse controls, metrics, tests и Session Log.
