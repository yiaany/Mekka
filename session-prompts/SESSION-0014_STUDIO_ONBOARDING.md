# SESSION-0014: Studio Quick Setup

## Цель
Пользователь создает organization/project через короткий wizard и получает готовый API connection screen.

## Зависимости
- SESSION-0002, SESSION-0003, SESSION-0013.

## Upstream Sources
- Pinned Supabase Studio onboarding components из SESSION-0012.
- Извлечь подходящие forms/layout; cloud API заменить полностью.

## Scope
- Organization/project creation state machine.
- Название, region, template и enabled modules.
- Безопасные defaults, provisioning status, URL/key snippets и connection health test.

## Out of Scope
- Billing checkout, GitHub Connect и full Auth.

## Acceptance Criteria
1. Project provisioning идемпотентен и показывает progress/failure recovery.
2. Первый health request выполняется без отдельной инструкции.
3. Advanced settings доступны после создания.

## Security
- Publishable и server secrets визуально/технически разделены.
- Failed provisioning не оставляет доступный orphan resource.

## Tests
- State machine integration, UI wizard и provisioning retry tests.

## Deliverables
- Onboarding vertical slice, docs и Session Log.
