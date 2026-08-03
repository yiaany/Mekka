# SESSION-0035: Supabase Auth compatible subset

## Цель
Поддержать основные `supabase-js` Auth flows поверх Better Auth service.

## Зависимости
- SESSION-0018, SESSION-0019, SESSION-0034.

## Upstream Sources
- `https://github.com/supabase/supabase-js` и `https://github.com/supabase/auth`.
- Клонировать/pin commits; GoTrue использовать только для endpoint/error/flow reference и fixtures.
- Не переносить PostgreSQL persistence/server implementation.

## Scope
- Compatible subset signUp, signInWithPassword, OTP/magic link, refresh, signOut, getUser/getSession и OAuth redirect.
- `/auth/v1` adapter и error mapping.

## Out of Scope
- Полная GoTrue admin API, every provider, SAML и hooks parity.

## Acceptance Criteria
1. Pinned `supabase-js` выполняет supported flows.
2. Security properties Better Auth не ослаблены ради response parity.
3. Unsupported option дает explicit error.

## Security
- Token issuer/audience, refresh rotation, redirect validation, abuse limits.

## Tests
- Differential happy/error flows, replay, enumeration и cross-project tests.

## Deliverables
- Auth adapter, compatibility matrix, provenance и Session Log.
