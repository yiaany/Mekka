# SESSION-0020: Auth management в Studio

## Цель
Пользователь управляет Auth users, providers, redirect URLs и email templates через Studio.

## Зависимости
- SESSION-0013, SESSION-0018, SESSION-0019.

## Upstream Sources
- Pinned Supabase Studio Auth screens.
- Извлечь подходящие UI components/flows; GoTrue-specific client заменить Studio Domain SDK.

## Scope
- Users list/detail/revoke, provider settings, URL allowlist и templates.
- Safe secret update flow и audit events.
- Скрыть unsupported Supabase Auth options.

## Out of Scope
- MFA и enterprise SSO.

## Acceptance Criteria
1. Studio показывает project-isolated users/sessions.
2. Provider secret никогда не возвращается после сохранения.
3. Dangerous account action требует confirmation.

## Security
- Admin capability, CSRF/session protection, PII redaction и audit.

## Tests
- Component/e2e user revoke, provider config, redirect validation и cross-project tests.

## Deliverables
- Studio Auth feature, tests и Session Log.
