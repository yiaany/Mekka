# SESSION-0018: Email/password и OTP lifecycle

## Результат
COMPLETED

## Что сделано
- В production auth store включены email/password registration и login с обязательной email verification.
- Добавлен Better Auth `email-otp`: verification и password-reset OTP имеют TTL 5 минут, три допустимые попытки и хранятся в hashed form.
- Добавлены typed `AuthEmailProvider`, тексты verification/reset писем и `LocalAuthEmailSink` для локальных/integration сценариев.
- Password reset отзывает все Better Auth sessions и refresh tokens пользователя только в его tenant-local store.
- Добавлен `POST /refresh`: HMAC-stored refresh tokens однократны, при успешном refresh создается новая session/token пара; reuse, expiry или invalid token отзывают все user sessions/refresh tokens.
- Better Auth database rate limiting включен для password и OTP routes; OTP delivery ограничен тремя запросами за минуту.

## Upstream
- Better Auth: `https://github.com/better-auth/better-auth`, tag `v1.6.10`, commit `698678bcd08e0552661f9ae306b031674e588a2c`, MIT. Проверено 4 августа 2026 года.
- Upstream временно клонирован в `C:\Users\ilyaa\AppData\Local\Temp\opencode\better-auth-v1.6.10-email`.
- Изучены email/password routes, `email-otp`, OTP hashing/atomic verification, rate limiter, reset-session revocation и one-time token implementation.
- Используются published APIs `better-auth`, `better-auth/plugins/email-otp` и `better-auth/crypto`; source code не копировался, поэтому отдельные LICENSE/NOTICE files не требуются.

## Архитектурные решения
- Email delivery остается replaceable server-side boundary; test sink хранит сообщения только в памяти и не логирует OTP.
- OTP, password hashing и verification реализуются Better Auth upstream; product code не содержит криптографических primitives.
- Refresh records содержат только HMAC signature. Raw refresh token сохраняется только в response и не пишется в database/logs.
- Reuse detection revoke-ит все sessions и refresh tokens этого user в tenant-local store, чтобы украденная rotating chain не пережила replay.

## Измененные файлы
- `packages/auth-core/src/index.ts`: email/password, email OTP, mail abstraction, refresh rotation/reuse detection и revocation.
- `packages/auth-core/test/auth-core.test.ts`: end-to-end lifecycle, reset/enumeration, OTP hashing/replay/rate limit and tenant mail isolation.
- `packages/auth-core/README.md`: documented production auth lifecycle.

## Безопасность
- Login требует verified email; registration не auto-sign-in.
- OTP hashed at rest, expires after 5 minutes, has bounded verification attempts and request rate limit.
- Password reset endpoint returns indistinguishable body for known/unknown email.
- Refresh tokens use HMAC at rest, rotate atomically and reuse revokes tenant-local user credentials.
- Preview cannot enable credentials because email/password and OTP plugins are production-only.

## Проверки
- `bun test packages/auth-core/test/auth-core.test.ts`: PASSED, 6 tests.
- `bun run typecheck`: PASSED.

## Совместимость
- Supported: native Better Auth email/password, email OTP verification/reset, session logout/revocation and Mekka `POST /refresh` rotation endpoint.
- Deliberate scope limits: OAuth, MFA, JWT/JWKS and Supabase `/auth/v1` compatibility are absent.

## Ограничения и риски
- Email provider production adapters and durable asynchronous mail delivery are deferred; callers must provide a server-side provider.
- Refresh is a native Mekka endpoint, not a Better Auth/OAuth refresh-token compatibility endpoint.
- Password hash parameter upgrades are delegated to Better Auth; a versioned automatic rehash policy needs a future upstream-supported migration decision.

## Следующая рекомендуемая сессия
- `SESSION-0019`: OAuth providers, JWKS and signed access-token issuance bound to the tenant tuple.
