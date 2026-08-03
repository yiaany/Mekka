# SESSION-0011: `sqlite-meta` management API

## Цель
Создать backend, через который Studio управляет tables, columns и indexes SQLite-проекта.

## Зависимости
- SESSION-0004, SESSION-0010.

## Upstream Sources
- `https://github.com/supabase/postgres-meta`.
- Выполнить временный clone pinned commit; извлечь API routes, schemas, types и tests для tables/columns/indexes.
- Не копировать PostgreSQL catalog SQL и DDL generator.

## Scope
- `list/create/update/delete` table subset.
- Add/rename supported columns, PK и indexes.
- Каждая mutation создает migration artifact и invalidates schema manifest.
- Stable Studio-facing DTO, не raw PRAGMA output.

## Out of Scope
- Triggers, extensions, generated columns, arbitrary SQL и Studio UI.

## Acceptance Criteria
1. Management operations работают через HTTP и temporary database.
2. Unsupported PostgreSQL options дают explicit error.
3. Concurrent stale schema update дает conflict.

## Security
- Tenant authorization, validated identifiers, checkpoint перед destructive DDL.

## Tests
- Contract tests по мотивам postgres-meta, SQLite integration и injection cases.

## Deliverables
- `apps/sqlite-meta`, protocol types, tests, provenance и Session Log.
