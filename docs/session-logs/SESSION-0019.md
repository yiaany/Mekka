# SESSION-0019: OAuth и JWT/JWKS

## Результат
COMPLETED

## Что сделано
- Добавлены Google/GitHub OAuth через pinned Better Auth с state cookie, PKCE S256 и callback lifecycle в test harness.
- OAuth включается только для production auth store; provider credentials читаются из server-side `AuthSecretStore`.
- Redirect URL проходит точное сравнение с canonical HTTPS allowlist, а issuer и все redirect origins требуют tenant-bound ownership verification до открытия store.
- Implicit account linking отключен. Явное linking допускается Better Auth только для совпадающего email; different-email и unlink-all запрещены.
- Provider access/refresh/ID tokens шифруются Better Auth в auth SQLite и не возвращаются клиенту через redirect, `/token` или `/refresh`.
- Добавлена выдача 15-минутных ES256 project JWT с `kid`, issuer, audience, `sid`, `jti`, authenticated role и полным tenant tuple.
- Добавлены `POST /token`, JWT-aware `POST /refresh`, `GET /.well-known/jwks.json` и typed `verifyAccessToken`.
- `AuthSigningKeyStore` предоставляет current private/public key pair и public overlap keys. JWKS автоматически исключает overlap key после его срока публикации.
- Добавлен runbook компрометации signing key с немедленным удалением скомпрометированного `kid`, отзывом sessions/refresh chains и очисткой verifier caches.

## Upstream
- Better Auth: `https://github.com/better-auth/better-auth`, tag `v1.6.10`, commit `698678bcd08e0552661f9ae306b031674e588a2c`, MIT. Использован ранее approved clone `C:\Users\ilyaa\AppData\Local\Temp\opencode\better-auth-v1.6.10-pnpm`.
- Изучены Google/GitHub providers, social sign-in/callback, state/PKCE, redirect validation, account linking и OAuth token encryption. Используется published `better-auth@1.6.10`; source code не копировался.
- JOSE: `https://github.com/panva/jose`, tag `v6.2.3`, commit `41ad7e9a76d270ca7e24b7421a88e507f756f2db`, annotated tag object `005cf0cb3627dcfed02bbc73c46f4e2f3b4d30c8`, MIT. Clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\jose-v6.2.3`.
- Используется published `jose@6.2.3` для ES256 signing, strict JWT verification и local JWKS resolution; JOSE primitives вручную не реализовывались.

## Архитектурные решения
- Better Auth session token остается server-side credential. Клиент получает отдельный короткоживущий project JWT, поэтому opaque session token не становится Data API bearer contract.
- OAuth callback устанавливает HTTP-only Better Auth session, затем `POST /token` выдает native access/refresh pair. Provider tokens не проходят через клиентский contract.
- JWT claims и verifier привязаны к issuer/audience полного tenant tuple, включая generation; tenant mismatch всегда отклоняется.
- Normal rotation публикует старый public JWK только до заданного overlap deadline. Для compromise runbook требует немедленного удаления без overlap.
- Key ring загружается при открытии auth service; control plane обязан reload/restart instance после rotation/revocation.

## Измененные файлы
- `packages/auth-core/src/index.ts`: OAuth configuration, secret/domain boundaries, token exchange, JWT-aware refresh, JWKS route и access-token verification.
- `packages/auth-core/src/jwt.ts`: ES256 key-ring validation, issuance, JWKS publication и strict claims verification.
- `packages/auth-core/test/auth-core.test.ts`: OAuth attack matrix, PKCE/state callback harness, no-token-passthrough, account-linking, ownership, JWT validation и rotation tests.
- `packages/auth-core/package.json`, `bun.lock`: pinned `jose@6.2.3` dependency.
- `packages/auth-core/README.md`: OAuth/JWT public contract и upstream provenance.
- `docs/runbooks/auth-signing-key-compromise.md`: signing-key compromise procedure.

## Безопасность
- Предотвращены open redirect и near-match redirect через exact canonical allowlist; wildcard redirects отсутствуют.
- Unverified custom-domain origin блокирует startup до чтения OAuth credentials и открытия auth store.
- State replay отклоняется; authorization URL и token exchange подтверждают PKCE S256/code verifier.
- Client-supplied provider ID/access/refresh tokens, custom scopes и arbitrary OAuth state data запрещены на public social sign-in route.
- Implicit same-email account linking отключен; тест подтверждает отсутствие takeover/linking при существующем password account.
- OAuth tokens encrypted at rest и отсутствуют в redirect/token responses.
- JWT принимает только ES256, активный `kid`, точные issuer/audience, допустимый срок и полный tenant tuple; JWKS не содержит private `d`.
- Rotation test подтверждает прием старого допустимого access token в overlap и отказ до его `exp` после удаления старого key из JWKS.

## Проверки
- `bun test packages/auth-core/test/auth-core.test.ts`: PASSED, 9 tests, 91 assertions.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `bun run typecheck`: PASSED.
- `bun run test`: PASSED, 81 tests, 368 assertions.
- `bun run build`: PASSED.
- `bun run smoke:health`: PASSED.
- `git diff --check`: PASSED.
- `pnpm exec vitest run packages/better-auth/src/social.test.ts` в Better Auth clone: PASSED, 49 tests.
- `npm install` в JOSE clone: PASSED.
- `npm run build` в JOSE clone: PASSED.
- `npm audit --omit=dev` в JOSE clone: PASSED, 0 production vulnerabilities.
- `bun pm scan`: FAILED, repository не настраивает Bun security scanner в `bunfig.toml`; dependency pin/license и upstream production audit проверены отдельно.

## Совместимость
- Supported: native Google/GitHub OAuth redirect flow, Better Auth session exchange, Mekka ES256 project JWT, JWKS и existing rotating refresh endpoint.
- Email/password login response теперь возвращает `accessToken`, `expiresIn`, `tokenType` и `refreshToken`, не раскрывая Better Auth session token.
- Deliberately unsupported: OAuth direct ID-token sign-in, client-selected provider scopes, wildcard/non-HTTPS redirects, implicit account linking, Enterprise SSO/MFA и Supabase `/auth/v1` compatibility.

## Ограничения и риски
- Auth service должен быть reload/restart после normal rotation или emergency key revocation; hot key-registry subscription не входит в этот slice.
- Уже выданный stateless access JWT остается действительным до 15 минут, если его key не удален из verifier JWKS. Session/refresh revocation мгновенна в auth store; per-token denylist не добавлялся.
- Google/GitHub tests используют deterministic local HTTP mocks и реальные Better Auth provider contracts, но не вызывают внешние production provider tenants.
- Centralized immutable auth audit persistence остается в scope SESSION-0039; текущий slice не логирует secrets/tokens и не добавляет локальный псевдо-audit.

## Следующая рекомендуемая сессия
- `SESSION-0020`: Auth users/providers/redirect settings в Studio через admin capability, safe secret update, CSRF protection и audit boundary.
