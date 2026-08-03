# SESSION-0016: Row grid и SQL Editor

## Цель
Дать человеку просмотр/редактирование rows и безопасный administrative SQL workflow в Studio.

## Зависимости
- SESSION-0008, SESSION-0009, SESSION-0013, SESSION-0015.

## Upstream Sources
- Pinned Supabase Studio row grid и SQL Editor components.
- Извлечь UI/UX; PostgreSQL explain/features адаптировать или скрыть.

## Scope
- Row pagination/filter/edit/delete через Studio Domain SDK.
- SQL editor с read-only default и отдельным privileged execution flow.
- Query history без secrets/PII и cancellation/timeout.

## Out of Scope
- AI SQL generation и Postgres planner advisor.

## Acceptance Criteria
1. Row grid корректно работает на больших paginated tables.
2. Write SQL требует explicit elevated capability.
3. Multi-statement/dangerous SQL блокируется согласно policy.

## Security
- Service capability хранится server-side; query/result limits и audit.

## Tests
- UI/e2e CRUD, timeout, cancellation, privilege и redaction tests.

## Deliverables
- Row/SQL surfaces, tests и Session Log.
