# SESSION-0032: Functions sandbox runtime

## Цель
Выбрать и интегрировать безопасный runtime для пользовательских TypeScript Functions.

## Зависимости
- SESSION-0001, SESSION-0019.

## Upstream Sources
- `https://github.com/supabase/edge-runtime`.
- Клонировать во временную директорию, проверить MIT, pin commit.
- Изучить main/user runtime separation, worker lifecycle, limits и tests.
- Провести spike: использовать component целиком, адаптировать или отказаться с ADR.

## Scope
- Isolated worker boundary, immutable bundle, invocation protocol и resource limits.
- Local hello function и host-call allowlist.
- ADR с measured startup/memory/security tradeoffs.

## Out of Scope
- Cloud deployment UI, cron, billing и full Supabase compatibility.

## Acceptance Criteria
1. Function не имеет host filesystem/process access.
2. Timeout/memory/response limits принудительно работают.
3. Crash user function не падает gateway/control plane.

## Security
- Network deny/default policy, no inherited secrets, dependency/provenance review.

## Tests
- Escape attempts, timeout, crash, concurrent isolation и benchmark smoke.

## Deliverables
- Runtime spike/integration, ADR, tests, provenance и Session Log.
