# SESSION-0019: OAuth и JWT/JWKS

## Цель
Добавить Google/GitHub OAuth и безопасную выдачу/проверку project JWT.

## Зависимости
- SESSION-0017, SESSION-0018.

## Upstream Sources
- Pinned Better Auth OAuth implementation.
- `https://github.com/panva/jose`; проверить LICENSE/tag и использовать библиотеку, не писать JOSE вручную.

## Scope
- OAuth state, PKCE, exact redirect allowlist и account linking rules.
- Asymmetric signing keys, `kid`, JWKS endpoint и rotation overlap.
- Access/refresh validation matrix.

## Out of Scope
- Enterprise SSO и MFA.

## Acceptance Criteria
1. Google/GitHub callback lifecycle работает в test harness.
2. Wrong issuer/audience/expired token отклоняется.
3. Key rotation не ломает допустимые старые access tokens.

## Security
- Custom-domain ownership, no token passthrough, signing-key compromise runbook.

## Tests
- OAuth attack matrix, JWT validation и rotation integration tests.

## Deliverables
- OAuth/JWKS feature, runbook, tests и Session Log.
