# SESSION-0028: Read-only MCP

## Цель
Подключить AI к project schema, policies, migrations и sanitized logs без write privileges.

## Зависимости
- SESSION-0004, SESSION-0007, SESSION-0010, SESSION-0019.

## Upstream Sources
- `https://github.com/modelcontextprotocol/typescript-sdk`.
- Клонировать/pin commit, проверить mixed LICENSE и поддерживаемую protocol revision.
- Извлечь server transport, authorization contracts и tests/examples.

## Scope
- Local stdio и remote HTTP server.
- Resources schema/policies/migrations/logs/capabilities.
- Tools `inspect_schema`, `explain_query`, `list_migrations`, `get_policy_summary`.

## Out of Scope
- Любые writes и arbitrary SQL.

## Acceptance Criteria
1. Agent видит только свой project/branch.
2. Resources не содержат secrets/unsafe raw logs.
3. Expired/wrong audience token отклоняется.

## Security
- OAuth resource metadata, PKCE/audience, no token passthrough, prompt-input provenance.

## Tests
- Protocol/transport, scope, cross-tenant, redaction и prompt-injection fixtures.

## Deliverables
- `apps/mcp`, config docs, tests, provenance и Session Log.
