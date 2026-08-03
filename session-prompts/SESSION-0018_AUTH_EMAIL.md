# SESSION-0018: Email/password и OTP lifecycle

## Цель
Реализовать registration, verification/OTP, login, refresh, logout и password reset.

## Зависимости
- SESSION-0017.

## Upstream Sources
- Pinned Better Auth repository/API.
- Использовать upstream plugins/flows, не писать crypto/token primitives вручную.

## Scope
- Email/password registration/login.
- Verification or magic-link/OTP flow, password reset и session revocation.
- Email provider abstraction и local test mail sink.

## Out of Scope
- OAuth, MFA и Studio management.

## Acceptance Criteria
1. Полный lifecycle проходит end-to-end.
2. Refresh rotation/reuse detection работает.
3. Responses не позволяют email enumeration.

## Security
- Rate limits, hashed one-time tokens, password rehash policy, no token logs.

## Tests
- Happy paths, expiry, replay, brute-force/rate limit и project isolation.

## Deliverables
- Auth endpoints, email templates, tests и Session Log.
