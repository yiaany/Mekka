# SESSION-0017: Better Auth foundation

## Цель
Создать project-isolated Auth service и persistence без копирования production credentials в branches.

## Зависимости
- SESSION-0002, SESSION-0003, SESSION-0010.

## Upstream Sources
- `https://github.com/better-auth/better-auth`.
- Клонировать во временную директорию, проверить MIT, pin stable commit/tag.
- Изучить SQLite adapter, core schema, adapter tests и session lifecycle; не переписывать core без необходимости.

## Scope
- Auth storage отдельно от application branch database.
- Project binding, issuer/audience, session store и service boundary.
- Preview auth mode: empty/synthetic users.

## Out of Scope
- UI, OAuth providers и Supabase `/auth/v1` compatibility.

## Acceptance Criteria
1. Два проекта не видят users/sessions друг друга.
2. Preview branch не содержит production credentials.
3. Better Auth adapter tests проходят.

## Security
- Secrets в secret store; password/session tables не доступны Data API.

## Tests
- Project isolation, preview isolation, adapter conformance и migration tests.

## Deliverables
- `auth-core`/service, schema, provenance и Session Log.
