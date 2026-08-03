# SESSION-0023: Storage UI в Studio

## Цель
Подключить Supabase-подобные bucket/file screens к нашему Storage API.

## Зависимости
- SESSION-0013, SESSION-0022.

## Upstream Sources
- Pinned `supabase/supabase/apps/studio` Storage screens.
- Pinned `supabase/storage` contract reference.
- Извлечь UI components и flows; заменить Supabase clients через Studio Domain SDK.

## Scope
- Bucket list/create/settings, file browser/upload/download/delete и policy summary.
- Progress, retry и clear provider/quota errors.

## Out of Scope
- Transform editor и advanced CDN settings.

## Acceptance Criteria
1. Пользователь управляет files без прямых object-provider credentials.
2. Large/interrupted upload отображает корректное состояние.
3. Unsupported controls скрыты.

## Security
- No secrets в browser; file names escaped; admin actions audited.

## Tests
- Component/e2e bucket/file lifecycle, permission и error tests.

## Deliverables
- Studio Storage feature, tests и Session Log.
