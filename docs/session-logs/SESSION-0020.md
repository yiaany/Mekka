# SESSION-0020: Auth management в Studio

## Результат
COMPLETED

## Что сделано
- Добавлен tenant-isolated Auth admin boundary для списка и detail users, просмотра sessions, отзыва всех user sessions, Google/GitHub providers, exact redirect allowlist и verification/reset email templates.
- Все privileged mutations требуют короткоживущую `auth:admin` capability полного tenant tuple, exact Studio origin, double-submit CSRF, idempotency key, correlation ID и audit event.
- Dangerous session revoke требует точного подтверждения user ID и отзывает Better Auth sessions вместе с Mekka refresh-token chain.
- Provider credentials сохраняются пакетно через secret-store boundary и никогда не возвращаются Studio. API и SDK показывают только `clientIdConfigured` и `clientSecretConfigured`.
- Provider enablement и redirect allowlist применяются к работающему Better Auth service через замену in-process runtime до завершения mutation.
- Новые redirect origins проходят tenant-bound ownership verification до audit, runtime apply и persistence.
- Email templates читаются из tenant Auth store в момент отправки и применяются без restart.
- Idempotency reservation сохраняется в `pending` после неопределенного external failure, поэтому retry не повторяет secret/runtime/audit side effects и возвращает conflict.
- Добавлен session-only Studio Domain SDK client со strict parsing, bounded inputs и redaction provider secrets.
- Добавлены Next и TanStack same-origin Auth admin proxy routes. Proxy проверяет project header, route/method allowlist, CSRF cookie/header и обязательный idempotency key.
- CSRF token переиспользуется в пределах cookie lifetime и кэшируется на клиенте по полному tenant tuple; parallel mutations больше не ротируют cookie друг у друга. Read requests не запрашивают CSRF token.
- Добавлен Mekka Auth UI для users, providers, redirect URLs и email templates. Unsupported MFA, Enterprise SSO и другие GoTrue-only экраны скрыты или перенаправляются на supported Auth routes.

## Upstream
- Supabase Studio: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, Apache-2.0. Pin и LICENSE повторно проверены 4 августа 2026 года.
- Адаптированы только релевантные Auth navigation, page composition и UI flows. Supabase Cloud API и GoTrue-specific data clients заменены Mekka Studio Domain SDK и Auth admin backend boundary.
- Better Auth остается pinned Auth runtime согласно `packages/auth-core/README.md`; upstream source code в этом slice не копировался.

## Архитектурные решения
- Admin settings хранятся в tenant-local Auth SQLite, но OAuth secrets остаются только в external secret store.
- Better Auth provider registry startup-bound, поэтому successful provider/redirect mutation сначала строит новый runtime с актуальными secrets/configuration, затем атомарно переключает handler reference и только после этого фиксирует settings response.
- Secret store предоставляет admin boundary пакетную запись и последующее чтение OAuth credentials. Это исключает частично примененную пару client ID/client secret и гарантирует, что новый runtime видит сохраненные значения.
- Redirect ownership проверяется для каждого distinct origin, а authorization request продолжает использовать exact canonical HTTPS URL comparison.
- Audit выполняется до privileged side effect. Если дальнейший external side effect имеет неопределенный результат, idempotency key остается зарезервированным и требует reconciliation вместо опасного автоматического повтора.
- Next API handler остается общей реализацией proxy contract; TanStack route использует существующий `toWebHandler` adapter и передает splat как Next-style `path`.

## Измененные файлы
- `packages/auth-core/src/admin.ts`: Auth admin routes, capability/CSRF/idempotency/audit contract, settings persistence, redirect validation и secret batching.
- `packages/auth-core/src/index.ts`: admin integration, live OAuth runtime replacement, ownership verification и runtime email templates.
- `packages/auth-core/test/auth-core.test.ts`: admin isolation, secret redaction, live config, ownership, CSRF, idempotency failure и revoke regressions.
- `packages/auth-core/README.md`: Auth admin runtime/security contract.
- `packages/studio-domain-sdk/src/index.ts`: strict session-only Auth admin client.
- `packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: tenant headers, CSRF mutation behavior и provider secret redaction.
- `apps/studio/data/studio-domain/auth-client.ts`: browser Auth client и tenant-scoped CSRF request cache.
- `apps/studio/pages/api/platform/auth-admin/[ref]/[...path].ts`: Next same-origin proxy и CSRF cookie boundary.
- `apps/studio/routes/api/platform/auth-admin/$ref/$.ts`: TanStack API route mirror.
- `apps/studio/routeTree.gen.ts`: generated TanStack route metadata.
- `apps/studio/components/interfaces/Auth/MekkaAuthManagement.tsx`: supported Auth management UI.
- `apps/studio/pages/project/[ref]/auth/` и `apps/studio/routes/project/$ref/auth/`: Next/TanStack Auth pages.
- `apps/studio/components/layouts/AuthLayout/AuthLayout.utils.ts`, `apps/studio/lib/fork-config.ts`, `apps/studio/lib/fork-routing.ts`: supported Auth navigation и route allowlist.
- `apps/studio/tests/fork/auth-management.test.tsx`, `apps/studio/tests/fork/fork-config.test.tsx`: UI confirmation/navigation regressions.
- `apps/studio/UPSTREAM.md`, `apps/studio/TANSTACK_MIGRATION.md`: provenance и dual-runtime route notes.

## Безопасность
- Full tenant tuple проверяется в capability и Studio proxy headers; cross-project access отклоняется.
- Mutation без matching origin/CSRF, admin action, valid TTL, idempotency key или correlation ID fail-closed.
- Provider secrets отсутствуют в API response, settings response, audit details и tests snapshots.
- Redirects принимают только canonical exact HTTPS URLs без credentials, fragment, duplicates или unverified origins.
- User/session responses ограничены pagination limits и bounded metadata; arbitrary Auth tables и credentials не экспонируются.
- Revoke требует typed confirmation и инвалидирует server sessions и refresh credentials.
- Pending idempotency record блокирует повтор external side effects после infrastructure uncertainty.
- Unsupported Auth administration routes не получают скрытый fallback к Supabase/GoTrue semantics.

## Проверки
- `bun run check`: PASSED; format, root lint, typecheck, 86 tests / 412 assertions, build и health smoke.
- `bun test packages/auth-core/test/auth-core.test.ts`: PASSED, 13 tests / 127 assertions.
- `bun test packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: PASSED, 13 tests / 48 assertions.
- `bun run typecheck:studio`: PASSED.
- `bun run test:studio:fork`: PASSED.
- Scoped Studio ESLint для Auth client, Next proxy и TanStack proxy: PASSED.
- `bun run build:tanstack`: PASSED; client build, SSR build, prerender и `/api/get-utc-time` smoke.
- `git diff --check`: PASSED.
- Полный `bun run lint:studio` не используется как acceptance signal: repository уже содержит unrelated conditional-hook errors в SQL/Table Editor.
- `bun run lint:ratchet` остается заблокирован unrelated existing `@tanstack/query/exhaustive-deps` violations; измененные Auth files проходят scoped ESLint.

## Совместимость
- Supported: users list/detail, session revoke, Google/GitHub enablement and write-only credentials, exact redirect allowlist, verification/reset templates, Next и TanStack Studio runtimes.
- Deliberately unsupported: MFA, Enterprise SSO, passkeys administration, OAuth server/apps, hooks, rate-limit screens и прочие GoTrue-only controls.
- Existing email/password, OAuth, JWT/JWKS и refresh contracts сохранены. Admin provider/redirect updates теперь применяются без service restart.

## Ограничения и риски
- Secret-store batch write и read-after-write consistency являются обязательным production adapter contract; реализация durable secret manager находится за этим boundary.
- Если audit успешно записан, а следующий external side effect завершился неопределенно, automatic retry блокируется pending idempotency record. Control plane должен предоставить reconciliation/операторский workflow для таких редких случаев.
- In-process runtime replacement рассчитан на один service instance. Multi-instance rollout потребует versioned configuration distribution и acknowledgement от каждого instance.
- Component fork tests проверяют dangerous confirmation и route/navigation contract; полноценный browser E2E с реальным deployed Studio Backend API остается последующей интеграционной проверкой.

## Следующая рекомендуемая сессия
- Продолжить по roadmap после `SESSION-0020`; для production hardening Auth admin добавить durable multi-instance configuration rollout и reconciliation pending idempotency operations в соответствующей control-plane сессии.
