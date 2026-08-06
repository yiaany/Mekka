# SESSION-0028: Read-only MCP

## Результат
COMPLETED

## Что сделано
- Добавлено приложение `apps/mcp` с read-only MCP server на `@modelcontextprotocol/sdk@1.30.0`.
- Добавлены local stdio transport с лимитом входного буфера и stateless remote Streamable HTTP transport с JSON responses.
- Добавлены resources `schema://current`, `schema://branch/{branchId}`, `policies://current`, `migrations://history`, `logs://recent` и `capabilities://session`.
- Добавлены tools `inspect_schema`, `explain_query`, `list_migrations` и `get_policy_summary`; все помечены `readOnlyHint`.
- Remote endpoint публикует OAuth protected-resource metadata для exact resource URL и authorization server.
- Добавлены protocol/transport, tenant-scope, expired capability, wrong-audience/expired token, redaction и prompt-injection tests.

## Upstream
- `https://github.com/modelcontextprotocol/typescript-sdk`, tag `1.30.0`, commit `2d889f2b329e46680ec9bdd565de4616c497825a` от 27 июля 2026 года, MIT, copyright 2024 Anthropic, PBC.
- Проверены `server/mcp`, stdio, Web Standard Streamable HTTP, OAuth protected-resource metadata/router и релевантные examples.
- Используется published `@modelcontextprotocol/sdk@1.30.0`; исходный код upstream не копировался и не vendor-ился. Полная provenance: `apps/mcp/UPSTREAM.md`.

## Архитектурные решения
- MCP принимает только уже проверенный `TenantContext` в stdio режиме. HTTP сначала получает `VerifiedAuthAccessToken`, затем подгружает tenant-bound capabilities и создает новый context; access token не передается дальше как domain credential.
- Project resolver обязан вернуть exact полный tenant tuple; несовпадение organization/project/environment/branch/generation запрещается.
- MCP не выполняет SQL: `explain_query` использует существующие manifest/parser/compiler и возвращает SQL template без parameters/values.
- Logs считаются untrusted prompt input: возвращаются только bounded metadata, message и attributes намеренно скрываются.
- История миграций возвращает только metadata applied artifacts; migration SQL не выдается.

## Измененные файлы
- `apps/mcp/src/index.ts`: MCP server, stdio/HTTP transport, OAuth resource metadata, auth/capability boundary, resources и tools.
- `apps/mcp/test/mcp.test.ts`: protocol, transport, tenant, expiry, redaction и HTTP authorization matrix.
- `apps/mcp/{package.json,tsconfig.json,README.md,UPSTREAM.md}`: workspace, type references, configuration, security contract и provenance.
- `package.json`, `tsconfig.json`, `bun.lock`: включение MCP workspace, test suite и dependency resolution.

## Безопасность
- `mcp:read` capability обязательна и проверяется повторно перед каждым resource/tool read; expired capability не дает доступ.
- HTTP bearer token отсутствует из MCP resources/tool outputs. Invalid, expired и wrong-audience token verifier errors возвращают auth failure.
- Полный tenant tuple и generation проверяются между authenticated context и resolved project; cross-tenant branch resource запрещен.
- Arbitrary SQL, writes, row data, credentials, raw migration SQL и raw logs отсутствуют в surface.
- SQL values не включаются в `explain_query`; sanitization tests покрывают token/secret/prompt-injection fixture.
- Известных Critical/High проблем в измененном path после self-review нет.

## Проверки
- `bun install`: PASSED.
- `bunx biome check --write apps/mcp package.json tsconfig.json`: PASSED.
- `bun test apps/mcp/test/mcp.test.ts`: PASSED, 4 tests, 22 assertions.
- `bun run typecheck`: PASSED.
- `bun run check`: PASSED, 156 tests, 791 assertions; format, lint, typecheck, build и health smoke completed.
- `npm test` в pinned MCP SDK clone: PARTIAL, 52 test files/1639 tests passed, но Vitest зафиксировал 2 unhandled `Unexpected end of JSON input` в upstream `test/client/stdio.test.ts` под local Node `v24.18.0`; Mekka не копирует и не изменяет этот upstream код.
- `git diff --check`: PASSED.

## Совместимость
- Supported: MCP TypeScript SDK protocol revision from tag `1.30.0`, stdio, stateless Streamable HTTP, OAuth protected-resource metadata and PKCE-capable external authorization server.
- Supported: branch-bound schema/policy/migration metadata and sanitized log metadata.
- Unsupported: write tools, arbitrary SQL, row-data inspection, direct token passthrough, embedded OAuth authorization server, capability issuance, audit persistence and persistent HTTP MCP sessions.

## Ограничения и риски
- OAuth authorization server, access-token verifier, capability persistence and immutable audit sink remain external control-plane dependencies. Their concrete deployment/integration needs to preserve the documented exact audience and tenant tuple checks.
- Logs are deliberately metadata-only until a centralized redaction policy and immutable audit/log service exist.
- HTTP transport is stateless; resumable SSE/event-store sessions are not required for this read-only slice.
- `npm install` в upstream clone сообщил 17 dependency vulnerabilities (1 low, 4 moderate, 11 high, 1 critical). Mekka использует published pinned package; dependency remediation относится к upstream release review, а не к локальному copied code, которого нет.

## Следующая рекомендуемая сессия
- `SESSION-0029`: mutating MCP operations only through preview plans/diffs, short-lived scoped capabilities, approval and immutable audit.
