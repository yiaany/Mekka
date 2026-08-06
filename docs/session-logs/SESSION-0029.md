# SESSION-0029: MCP mutations с preview и approval

## Результат
COMPLETED

## Что сделано
- В `@mekka/mcp` добавлены tools `create_preview_branch`, `propose_migration`, `apply_to_preview`, `validate_changes` и `request_promotion`.
- Добавлен durable SQLite mutation workflow: branch-bound preview reservation, migration proposal, apply, validation, promotion pending и promoted state machine.
- Proposal создает существующий allowlisted `MigrationArtifact`; tool result возвращает только plan metadata, hashes и risk marker, но не SQL text.
- `request_promotion` вызывает `McpStudioApprovalHook`. Decision привязан к tenant tuple, proposal ID, artifact hash, parent schema hash и preview schema hash.
- Production promotion требует одновременно approved decision и отдельный short-lived `mcp:promotion:execute`; затем используется CAS/idempotency promotion из `@mekka/branch-core`.
- Добавлен durable MCP audit ledger; отказ external audit delivery не удаляет запись и не отменяет committed branch state.
- Добавлены tests action scopes, branch binding, idempotent replay, stale preview schema, approval/step-up и audit sequence.

## Upstream
- `https://github.com/modelcontextprotocol/typescript-sdk`, published package/tag `1.30.0`, commit `2d889f2b329e46680ec9bdd565de4616c497825a`, MIT, copyright 2024 Anthropic, PBC.
- Использован pinned SDK из SESSION-0028. Повторно изучены contracts tools/annotations, Streamable HTTP authorization metadata и guidance по elicitation/authorization/tool results.
- Upstream code не копировался и не vendor-ился. Provenance: `apps/mcp/UPSTREAM.md`.

## Архитектурные решения
- MCP orchestration не дублирует branch lifecycle: branch creation, preview apply и production CAS promotion делегированы `@mekka/branch-core`.
- Capability проверяется у каждого mutating tool отдельно. Approval decision не является capability и сам по себе не дает production access.
- Approval принимает внешний Studio hook, но MCP проверяет все immutable bindings повторно перед promotion.
- Proposal и preview state persistятся по full tenant tuple; idempotency key нельзя переиспользовать другим actor/tenant.
- Audit сначала persistится в workflow catalog, а external sink является delivery boundary.

## Измененные файлы
- `apps/mcp/src/index.ts`: mutation tools, workflow state machine, scoped authorization, Studio hook contract и audit ledger.
- `apps/mcp/test/mcp.test.ts`: mutation authorization, stale validation, approval, promotion replay и audit tests.
- `apps/mcp/{package.json,tsconfig.json,README.md,UPSTREAM.md}`: branch-core dependency, contract и upstream provenance.
- `bun.lock`: workspace dependency resolution.

## Безопасность
- Mutations неизменно branch-bound; нет path к direct production SQL.
- Tool output, prompt text, logs и approval response не могут добавить scope: scope берется только из validated tenant-bound capabilities.
- Destructive DDL сначала проходит preview/apply/validate и не достигает production без Studio approval, step-up scope и branch-core schema CAS.
- Approval и validation invalidated by changed tenant/artifact/parent hash/preview hash or expiry.
- SQL и secrets не попадают в mutation tool results; raw credential/token не передается workflow.
- Retry не повторяет create/apply/promotion: persisted state возвращается как replay.

## Проверки
- `bun install`: PASSED.
- `bunx biome check --write apps/mcp`: PASSED.
- `bun test apps/mcp/test/mcp.test.ts`: PASSED, 6 tests, 40 assertions.
- `bun run typecheck`: PASSED.
- `bun run build`: PASSED.
- `bun run check`: PASSED, 158 tests and 809 assertions; format, lint, typecheck, build and health smoke completed.
- `git diff --check`: PASSED.

## Совместимость
- Supported: MCP TypeScript SDK `1.30.0`, read-only tools from SESSION-0028 and branch-bound preview migration workflow.
- Supported: external Studio approval adapter through `McpStudioApprovalHook` and external durable audit delivery.
- Unsupported: direct production SQL, automatic approval, approval from tool/prompt text, production credential passthrough and arbitrary migration SQL.

## Ограничения и риски
- Concrete Studio UI/control-plane persistence for `McpStudioApprovalHook` remains an integration dependency; it must authenticate approvers and persist decisions durably.
- The workflow catalog persists audit events, but retry of failed external audit delivery requires a control-plane delivery worker.
- Lifecycle version inherits one migration artifact per preview branch from SESSION-0027.

## Следующая рекомендуемая сессия
- `SESSION-0030`: Connect analyzer with sandboxed repository analysis and generated integration plan.
