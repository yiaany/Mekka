# SESSION-0012: Private fork Supabase Studio

## Цель
Импортировать рабочий Supabase Studio как лицензированный private fork без Supabase branding и cloud coupling. НО НЕ МЕНЯТЬ UI

## Зависимости
- SESSION-0001, SESSION-0011.

## Upstream Sources
- `https://github.com/supabase/supabase`, компонент `apps/studio` и реально необходимые workspace packages.
- Выполнить `git clone --filter=blob:none https://github.com/supabase/supabase <temp>/supabase`.
- Проверить Apache-2.0, pin commit, сохранить LICENSE/NOTICE/provenance.
- Предпочесть private fork/upstream remote или документированный subtree; не копировать весь monorepo в продукт.

## Scope
- Импортировать buildable Studio и минимальный dependency closure.
- Удалить/заменить branding, hosted URLs, analytics и Supabase Cloud bootstrap.
- Добавить neutral local shell и feature flags для unsupported screens.

## Out of Scope
- Подключение Table Editor и billing.

## Acceptance Criteria
1. Studio устанавливается и собирается внутри нашего monorepo.
2. Нет видимого Supabase branding и вызовов Supabase Cloud.
3. Upstream commit/license документированы.
4. Unsupported screens скрыты, а не сломаны.

## Security
- Не переносить upstream secrets/env; dependency scripts проверить.

## Tests
- Lint/typecheck/build, startup smoke и branding/cloud endpoint scan.

## Deliverables
- `apps/studio`, provenance/update guide и Session Log.
