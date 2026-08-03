# SESSION-0015: Studio Table Editor

## Цель
Пользователь создает и изменяет SQLite tables/columns через знакомый Supabase Table Editor.

## Зависимости
- SESSION-0011-0014.

## Upstream Sources
- Pinned `supabase/supabase/apps/studio` Table Editor.
- Pinned `https://github.com/supabase/postgres-meta` contracts/tests как reference.
- Если clones отсутствуют, клонировать во временную директорию и pin commits.

## Scope
- Подключить list/create/update/delete table и supported columns через Studio Domain SDK.
- Скрыть extensions, Postgres roles/schemas и unsupported column options.
- Показывать generated migration diff и destructive confirmation.

## Out of Scope
- Row grid, raw SQL и foreign-key visual editor.

## Acceptance Criteria
1. Table/column changes отражаются без reload.
2. Unsupported option невозможно отправить скрытым payload.
3. Stale schema дает conflict/reload flow.

## Security
- Tenant authorization, identifier validation, checkpoint для destructive DDL.

## Tests
- Component/e2e create/alter/delete, injection и cross-project tests.

## Deliverables
- Working Table Editor, tests, compatibility notes и Session Log.
