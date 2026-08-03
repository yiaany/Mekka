# SESSION-0004: Schema manifest

## Цель
Получать детерминированное versioned описание SQLite schema для API, Studio и MCP.

## Зависимости
- SESSION-0003.

## Upstream Sources
- Официальная SQLite документация по `PRAGMA table_list`, `table_xinfo`, foreign keys и indexes.
- Repository clone не требуется.

## Scope
- Реализовать introspection tables, columns, PK/FK, indexes и unique constraints.
- Создать canonical serialization, schema hash и cache invalidation contract.
- Исключить internal runtime tables из public manifest.

## Out of Scope
- Policies, functions и PostgreSQL schemas.

## Acceptance Criteria
1. Одинаковая schema дает одинаковый hash.
2. Любое поддержанное DDL-изменение меняет manifest/version.
3. Internal metadata не раскрывается клиенту.

## Security
- Identifier quoting не смешивается с value parameters.
- Manifest не содержит secrets/data rows.

## Tests
- Golden fixtures, deterministic ordering и malformed schema cases.

## Deliverables
- `schema-manifest`, tests, format docs и Session Log.
