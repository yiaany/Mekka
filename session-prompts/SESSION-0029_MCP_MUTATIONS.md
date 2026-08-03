# SESSION-0029: MCP mutations с preview и approval

## Цель
Позволить AI предлагать и применять backend changes без прямого production admin access.

## Зависимости
- SESSION-0027, SESSION-0028.

## Upstream Sources
- Pinned MCP TypeScript SDK из SESSION-0028.
- Изучить official elicitation/authorization/tool-result guidance для pinned revision.

## Scope
- Tools `create_preview_branch`, `propose_migration`, `apply_to_preview`, `validate_changes`, `request_promotion`.
- Plan/diff, risk result, step-up capability и approval state machine.

## Out of Scope
- Direct production SQL и automatic approval всех changes.

## Acceptance Criteria
1. Mutating tool всегда branch-bound и audited.
2. Destructive change без approval не достигает production.
3. Prompt text/tool result не может повысить scope.
4. Retry не дублирует operation.

## Security
- Short TTL, action scopes, CAS promotion, no secrets в resources/results.

## Tests
- Tool authorization matrix, injection chain, stale branch, approval и idempotency.

## Deliverables
- MCP mutation workflow, tests, Studio approval hook и Session Log.
