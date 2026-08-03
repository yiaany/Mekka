# SESSION-0013: Studio Domain SDK

## Цель
Создать стабильную typed boundary между Studio и нашими backend services.

## Зависимости
- SESSION-0011, SESSION-0012.

## Upstream Sources
- Использовать pinned Supabase Studio fork; изучить его existing data hooks/clients.
- Новый upstream clone не нужен, если commit не меняется.

## Scope
- Создать `packages/studio-domain-sdk` с tenant-aware client, errors и request cancellation.
- Реализовать table list/schema health operations через `sqlite-meta`.
- Заменить один вертикальный Studio data path на SDK.

## Out of Scope
- Полная миграция всех Studio hooks.

## Acceptance Criteria
1. Studio показывает tables через наш API.
2. Raw PRAGMA/provider DTO не попадает в components.
3. Unauthorized/conflict/error states отображаются явно.

## Security
- Browser получает только publishable/session credentials; no service role.

## Tests
- SDK contract, component integration и aborted request tests.

## Deliverables
- SDK, migrated path, docs и Session Log.
