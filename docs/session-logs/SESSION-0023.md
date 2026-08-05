# SESSION-0023: Storage UI в Studio

## Результат
COMPLETED

## Что сделано
- Добавлен browser-safe `createStudioStorageClient` с bucket list/create/get/update/delete, object list/upload/signed-download/delete и read-only policy summary.
- Реализованы standard upload и fixed-length sequential resumable upload с progress, повторным `HEAD` после потерянного ответа и продолжением с authoritative offset.
- Повторный create resumable upload с тем же tenant, actor, idempotency key, target, length и content type возвращает исходную session, даже если transport пересчитал expiry.
- Gateway публикует authenticated Storage admin subset: bucket CRUD, bounded object listing и effective policy summary.
- Storage list использует отдельное policy action `object:list`; административные bucket mutations и policy summary требуют tenant-bound `storage:admin` capability дополнительно к Storage policy.
- Добавлены audit events для bucket mutations, object create/delete, signed grant issuance и upload abort. Object path сохраняется только как SHA-256 hash; bodies, tokens, provider keys и credentials не записываются.
- Studio Storage pages переключены на Mekka Domain SDK: private bucket list/create, file browser, upload progress/retry, signed download, delete и read-only policy summary.
- Добавлены constrained same-origin proxies для Next и TanStack runtimes. Оба проверяют auth/tenant/CSRF, allowlist path/method и bounded body; TanStack proxy сохраняет binary bytes без text decoding.
- Скрыты unsupported Analytics/Vector/S3 navigation, global settings tab, public/CDN/transforms controls, move/rename и PostgreSQL RLS policy editor.
- Запрещенные текущей policy действия не рендерятся в bucket screen.
- Исправлены 17 `react-hooks/rules-of-hooks` errors в Table Editor и SQL Editor: route components теперь выбирают SQLite/legacy child до входа в hook-heavy component, поэтому hooks внутри каждого child всегда вызываются в стабильном порядке.
- Устранен последний Studio lint error: ссылка SQLite Table Editor получила явный keyboard `tabIndex`.
- Обновлены OpenAPI, compatibility docs, Storage core/SDK docs и upstream provenance.

## Upstream
- Studio repository: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, annotated commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`; tag object `a26446c913d2aff2beedbc0d181a42c13da161b7`; проверено 5 августа 2026 года через `git ls-remote`.
- Studio license: Apache-2.0; сохранена в `apps/studio/UPSTREAM_LICENSE`; upstream `NOTICE` отсутствует на pinned commit.
- Storage repository: `https://github.com/supabase/storage`, tag `v1.68.4`, commit `7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`, commit date 4 августа 2026 года; существующий clone `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-storage-v1.68.4` повторно проверен.
- Storage license: repository `LICENSE` Apache-2.0; mismatch с root `package.json` (`ISC`) уже зафиксирован в `packages/storage-core/UPSTREAM.md`.
- Изученный scope: pinned Storage screens/layout/navigation, bucket/file flow, progress/error concepts, existing fork contracts; Storage signed URL и sequential upload contracts.
- Upstream source не копировался и не vendor-ился. Сохранены только UI flow/contracts concepts; Supabase service-role clients, temporary API keys, PostgreSQL RLS и provider-specific configuration не перенесены.

## Архитектурные решения
- Browser вызывает только same-origin `/api/platform/storage-admin/:ref/*`; object-provider credentials и service-role keys отсутствуют в SDK contract и browser bundle.
- Next proxy использует bounded raw stream, TanStack proxy использует отдельный bounded Web Request adapter. Общий Next compatibility adapter не используется для binary Storage payloads.
- Gateway остается единственным HTTP boundary перед `ObjectStorageCore`; Studio не строит provider URLs и получает download только через короткоживущий signed grant.
- Public bucket metadata пока сохраняется для будущей compatibility, но public delivery не реализован и control скрыт.
- Policy UI показывает effective booleans для текущего actor, а не PostgreSQL SQL/predicates. Policy editing требует отдельной versioned Storage policy model.
- Object metadata DTO исключает provider ETag/key; SDK дополнительно валидирует и сужает response contract.
- Resumable retry пересчитывает chunk после каждого authoritative `HEAD`; если server offset уже равен upload length, SDK не повторяет committed final bytes.

## Измененные файлы
- `packages/storage-core/src/object-storage.ts`: `object:list`, effective policy summary и stable resumable create retry.
- `apps/gateway/src/app.ts`: Storage audit event contract.
- `apps/gateway/src/storage.ts`: bucket/list/policy routes, capability checks, audit, HTTPS signed URL restriction и provider-neutral DTO.
- `apps/gateway/src/openapi.ts`, `apps/gateway/COMPATIBILITY.md`: Storage admin/UI HTTP subset.
- `apps/gateway/test/storage.test.ts`: SDK-to-gateway lifecycle, permissions, audit, retry и security regressions.
- `apps/gateway/test/gateway.test.ts`: устойчивый Windows temporary-directory cleanup для полного gate.
- `packages/studio-domain-sdk/src/storage.ts`: typed Storage client, binary/resumable transports, progress и retry.
- `packages/studio-domain-sdk/src/index.ts`, `README.md`, tests: exports, generic public errors и Storage contract coverage.
- `apps/studio/data/studio-domain/storage-client.ts`: tenant/session/CSRF bootstrap.
- `apps/studio/pages/api/platform/storage-admin/[ref]/[...path].ts`: Next constrained proxy.
- `apps/studio/lib/storage-admin-web-proxy.ts`, `routes/api/platform/storage-admin/$ref/$.ts`: bounded binary-safe TanStack proxy.
- `apps/studio/components/interfaces/Storage/MekkaStorageManagement.tsx`: bucket/file/policy screens.
- `apps/studio/components/interfaces/Storage/StorageMenuV2.tsx`, `components/layouts/StorageLayout/StorageBucketsLayout.tsx`: unsupported navigation hidden.
- `apps/studio/pages/project/[ref]/editor/[id].tsx`, `pages/project/[ref]/sql/[id].tsx`: stable hook order через отдельные legacy child components.
- `apps/studio/components/layouts/TableEditorLayout/StudioDomainEntityListItem.tsx`: explicit keyboard focus contract.
- `apps/studio/pages/project/[ref]/storage/files/*`: Mekka Storage pages wired into pinned layouts.
- `apps/studio/tests/fork/storage-management.test.tsx`, `storage-proxy.test.ts`: escaping, unsupported controls, policy display, CSRF and binary proxy tests.
- `apps/studio/UPSTREAM.md`, `packages/storage-core/README.md`, `packages/studio-domain-sdk/README.md`: provenance and supported contract.

## Безопасность
- Authentication выполняется до tenant comparison в gateway; проверяется полный organization/project/environment/branch/generation tuple и resolved project.
- Bucket administration и policy summary требуют короткоживущий tenant-scoped `storage:admin`; Storage policy остается независимым deny-by-default boundary.
- Same-origin mutations требуют double-submit CSRF cookie/header; production cookie использует `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`.
- Proxy allowlist ограничивает methods и paths; encoded `?`, `#`, `%`, Unicode и object path segments не декодируются повторно при upstream forwarding.
- Next и TanStack proxy ограничивают body 11 MiB; gateway и core независимо применяют object/chunk quotas и path limits.
- File names рендерятся React text nodes; regression test подтверждает escaping HTML-like name.
- Signed URLs разрешены только через HTTPS, кроме explicit localhost/127.0.0.1 development origin.
- Signed token, provider credentials, provider keys и object bytes не попадают в JSON DTO или audit.
- Два независимых review раунда исправили stale-chunk retry, отсутствующий TanStack proxy, invalid dev `__Host-` cookie, encoded-path corruption, binary text decoding, unbounded pre-auth buffering и unsupported/forbidden controls.
- После исправлений известных Critical/High проблем в измененном path не осталось.

## Проверки
- `git ls-remote https://github.com/supabase/supabase.git "refs/tags/self-hosted/v0.7.1" "refs/tags/self-hosted/v0.7.1^{}"`: PASSED.
- `git -C C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-storage-v1.68.4 rev-parse HEAD`: PASSED, `7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`.
- `bun run check`: PASSED; format, root lint, typecheck, 122 tests / 645 assertions, build и health smoke.
- `bun run typecheck` в `apps/studio`: PASSED.
- `bun run test:fork` в `apps/studio`: PASSED, включая Storage UI/proxy tests.
- `bun run lint` в `apps/studio`: PASSED, `0 errors`; сохранены 2181 существующий upstream warning.
- Targeted `bunx eslint` для измененных Studio Storage files: PASSED, zero errors/warnings.
- `bun run build` в `apps/studio`: PASSED; Next production build, 182 static pages.
- `bunx vite build --mode production` в `apps/studio`: PASSED; TanStack client/server build и prerender.
- `bun audit`: PASSED, `No vulnerabilities found`.
- `git diff --check`: PASSED.
- `bun run lint:ratchet` в `apps/studio`: FAILED на существующем dirty worktree baseline (`@tanstack/query/exhaustive-deps`, 13 violations в unrelated files); Storage targeted lint не добавляет violations.

## Совместимость
- Поддержаны native Mekka Storage bucket/file lifecycle, short-lived signed downloads и TUS-inspired fixed-length sequential upload subset.
- Standard upload сохраняет declared supported MIME; resumable upload намеренно сохраняется как `application/octet-stream` из-за текущего fail-closed gateway contract.
- Object listing ограничен первыми 100 canonical paths с optional prefix; cursor pagination и folder delimiter отсутствуют.
- Не заявляется полная Supabase Storage или TUS compatibility.
- Unsupported: public delivery, transforms, advanced CDN/S3 settings, multipart, overwrite/upsert, move/rename/copy, batch delete, deferred length, parallel uploads и editable PostgreSQL RLS policies.

## Ограничения и риски
- Audit callback вызывается после успешного provider/core operation и не имеет durable transactional outbox. Сбой audit sink после commit может вернуть 503 при уже выполненной операции; production audit delivery требует отдельной outbox с reconciliation.
- TanStack proxy проверяет presence Bearer token до bounded body read, но криптографическая/session validation выполняется upstream после чтения максимум 11 MiB. Это ограниченный resource-cost risk, не unbounded memory path.
- Standard upload и resumable assembly остаются memory-buffered в gateway/core; текущие limits ограничивают impact, streaming provider write остается отдельной feature.
- Object browser не показывает больше 100 objects и не синтезирует folder rows; крупные buckets требуют cursor/delimiter API.
- Нет live deployed browser E2E с реальным session issuer и S3/MinIO provider. In-process SDK-to-gateway lifecycle, Next/TanStack proxy tests и production builds проверяют измененные boundaries.
- Studio lint зеленый с `0 errors`; warning ratchet остается заблокирован существующими unrelated fork/worktree violations.

## Следующая рекомендуемая сессия
- Добавить cursor/delimiter object listing и streaming provider upload, затем покрыть bucket с более чем 100 objects live browser E2E.
