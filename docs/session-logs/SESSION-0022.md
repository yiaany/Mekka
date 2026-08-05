# SESSION-0022: Storage uploads и policies

## Результат
COMPLETED

## Что сделано
- Добавлен Storage HTTP API в gateway: authenticated raw `PUT`, `GET`, idempotent `DELETE`, signed read URL и фиксированный sequential resumable upload subset.
- Upload body и resumable chunks читаются bounded stream reader с независимой проверкой `Content-Length`; standard upload поддерживает optional SHA-256 клиента.
- Добавлена fail-closed MIME validation для `application/octet-stream`, UTF-8 `text/plain`, JSON, PNG, JPEG и PDF. Download всегда использует attachment, `nosniff`, exact length, checksum ETag и conditional `If-None-Match`.
- `ObjectProvider` расширен bounded `get`; local и S3 providers проверяют фактические bytes и SHA-256. S3 дополнительно проверяет caller checksum до upload.
- Добавлены policy-authorized `getObject`, signed read grants и metadata-only conditional read без provider download при `304`.
- Signed grant использует HMAC-SHA256, strict canonical base64url, `timingSafeEqual`, current/previous key rotation и привязку к полному tenant tuple, bucket, canonical path, object version, action и expiry.
- Metadata schema обновлена до `v2`; реализована транзакционная migration `v1 -> v2` с сохранением существующих bucket/object данных.
- Resumable subset хранится в SQLite, привязан к tenant и actor, требует fixed length и exact offset, имеет states `uploading -> finalizing -> complete`, quotas, expiry cleanup и retry-safe finalization через обычный idempotent `putObject`.
- Standard upload конфликтует с активной resumable reservation того же path или idempotency key.
- Ограничены logical object paths: до 180 UTF-8 bytes на segment и до 384 UTF-8 bytes на полный path; validation выполняется до metadata reservation и provider operation.
- Обновлены OpenAPI, compatibility matrix, storage-core README/provenance и root test command.

## Upstream
- Repository: `https://github.com/supabase/storage`, tag `v1.68.4`, commit `7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`, commit date 4 августа 2026 года.
- Повторно проверены официальный tag/commit и repository `LICENSE`: Apache-2.0, copyright 2019 Supabase; `NOTICE` отсутствует. Root `package.json` upstream указывает `ISC`, поэтому authoritative license и mismatch сохранены в `packages/storage-core/UPSTREAM.md`.
- Временный clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-storage-v1.68.4`.
- Изучены `src/http/routes/object/getSignedURL.ts`, object signed URL tests и `src/test/tus.test.ts`, включая expiry, policy-before-signing и interrupted sequential upload ideas.
- Извлечены только protocol/validation concepts. Upstream source не копировался и не vendor-ился; PostgreSQL repository/RLS, upstream TUS implementation, events, branding и cloud configuration не переносились.

## Архитектурные решения
- Gateway не получает прямой доступ к provider: authenticated и signed downloads проходят через `ObjectStorageCore`.
- Signed URL выдается только после обычной `object:read` policy evaluation. Redemption использует opaque verified grant и повторно проверяет exact target/version без synthetic admin context.
- URL строится только из configured public origin, а не из request `Host`; signed redemption rate limit выполняется до разбора attacker-controlled tenant query.
- Authenticated request сначала проходит authentication, затем tenant header parsing и exact tuple comparison, чтобы malformed headers не меняли `401` для неаутентифицированного клиента.
- Resumable `finalizing` нельзя abort/cleanup одновременно с provider write; это предотвращает успешный `204 abort` с последующим появлением объекта.
- Все non-expired resumable sessions, включая completed с retained BLOB, учитываются в session/byte quota до abort или expiry cleanup.
- Completed session сохраняет bytes для безопасного retry последнего PATCH после ambiguous provider response; explicit abort удаляет только session bytes и не удаляет уже созданный object.
- Resumable HTTP subset принимает только `application/octet-stream`: declared concrete MIME нельзя надежно проверить до получения полного файла.
- `304` проверяется по policy-authorized metadata или exact signed grant metadata до provider `get`, чтобы conditional requests не создавали лишний egress.

## Измененные файлы
- `packages/storage-core/src/object-provider.ts`: bounded object read contract.
- `packages/storage-core/src/local-object-provider.ts`: secure bounded local reads с checksum verification.
- `packages/storage-core/src/s3-object-provider.ts`: S3 `GetObject`, bounded body, checksum и key validation.
- `packages/storage-core/src/signed-read-grant.ts`: versioned HMAC read grants и key rotation window.
- `packages/storage-core/src/object-storage.ts`: downloads, signed redemption, resumable state machine/quotas, path limits и schema v2 migration.
- `packages/storage-core/src/index.ts`: public exports нового storage contract.
- `packages/storage-core/test/object-storage.test.ts`: provider, signed, migration, resumable, race, quota и path regression tests.
- `packages/storage-core/README.md`: supported contract, limits и residual assumptions.
- `packages/storage-core/UPSTREAM.md`: pinned provenance и extracted scope.
- `apps/gateway/src/storage.ts`: Storage HTTP routes, validation, signed URLs и TUS-inspired subset.
- `apps/gateway/src/app.ts`: Storage dependencies, project boundary и limits.
- `apps/gateway/src/openapi.ts`: Storage HTTP contract.
- `apps/gateway/test/storage.test.ts`: integration/security/E2E Storage tests.
- `apps/gateway/test/gateway.test.ts`: project fixture для обязательного object-storage boundary.
- `apps/gateway/COMPATIBILITY.md`: supported subset и explicit deviations.
- `package.json`: Storage gateway suite добавлен в root tests.

## Безопасность
- Проверяются authentication, полный tenant tuple, resolved project tuple, actor ownership resumable session и deny-by-default object policy.
- Предотвращены path traversal, encoded traversal, Windows/local path aliases, oversized UTF-8 paths и provider key overflow до metadata reservation.
- Bounded reads защищают от oversized `Content-Length`, chunked overflow, short body относительно declared length и oversized provider response.
- MIME spoofing отклоняется для concrete supported types; downloads используют attachment и `X-Content-Type-Options: nosniff`.
- SHA-256 проверяется на gateway, core и provider boundaries; S3 metadata не считается достаточным доказательством целостности download bytes.
- Signed grants отклоняют tampering, non-canonical aliases, expiry, wrong action/path/object version/project/generation и unknown signing key.
- Signed URL не уязвим к Host-header injection и имеет отдельный pre-tenant rate-limit boundary.
- Resumable finalization защищена от concurrent abort/cleanup; standard writes не могут занять reserved target.
- Quotas учитывают session count, reserved bytes, object size и chunk size; repeated upload/delete/final PATCH безопасны.
- Два независимых security review раунда исправили abort/finalization race, retained-BLOB quota bypass, token aliases, S3 checksum trust, conditional GET egress и provider-specific path deadlock. После исправлений известных Critical/High проблем в измененном path не осталось.

## Проверки
- `bunx biome check packages/storage-core/src packages/storage-core/test apps/gateway/src apps/gateway/test`: PASSED.
- `bunx tsc -b packages/storage-core/tsconfig.json apps/gateway/tsconfig.json --pretty false --force`: PASSED.
- `bun test apps/gateway/test/gateway.test.ts apps/gateway/test/storage.test.ts packages/storage-core/test/storage-adapter.test.ts packages/storage-core/test/object-storage.test.ts`: PASSED, 37 tests до remediation; финальные focused suites также PASSED.
- `bun run check`: PASSED; format check, lint, typecheck, 118 tests / 623 assertions, build и health smoke.
- `bun audit`: PASSED, `No vulnerabilities found`.
- `git diff --check`: PASSED.
- `$env:PGRST_JWT_SECRET='01234567890123456789012345678901'; node --env-file=.env.sample node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts src/test/object.test.ts -t "signedURL"` в upstream clone: BLOCKED до выполнения тестов, Windows не загружает native `fs-xattr` (`Cannot find module './build/Release/xattr'`).
- `$env:PGRST_JWT_SECRET='01234567890123456789012345678901'; node --env-file=.env.sample node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts src/test/tus.test.ts -t "resume an interrupted upload"` в upstream clone: BLOCKED по той же platform-specific причине до выполнения тестов.

## Совместимость
- Поддержаны native raw object upload/download/delete endpoints, read-only signed URL и TUS-inspired fixed-length sequential subset.
- Signed expiry измеряется в integer seconds на HTTP boundary и хранится как millisecond timestamp; максимальный TTL по умолчанию 3600 секунд.
- Resumable subset поддерживает `POST`, `HEAD`, `PATCH`, `DELETE`, `Tus-Resumable: 1.0.0`, `Upload-Length`, exact `Upload-Offset` и strict base64 `contentType` metadata.
- Не заявляется полная совместимость с Supabase Storage или TUS.
- Не поддерживаются multipart/form-data, upsert/overwrite, deferred length, concatenation, parallel uploads, creation-with-upload, Range download, public buckets, provider redirect, image transformations и client compatibility adapter.
- HTTP missing object использует существующий public error code `validation` со status `404`, поскольку protocol пока не содержит отдельный `not_found` code.

## Ограничения и риски
- Standard upload и final resumable assembly остаются memory-buffered; gateway cap по умолчанию 10 MB, chunk cap 1 MB. Streaming provider write является отдельным vertical slice.
- SQLite resumable sessions сохраняют полный BLOB до abort или expiry cleanup для retry-safe finalization; quota ограничивает retention, но production deployment должен регулярно запускать cleanup/reconciliation job, а не полагаться только на opportunistic create cleanup.
- `finalizing` session намеренно не истекает во время provider operation. Permanent provider infrastructure failure требует retry/reconciliation operator path; provider-safe input validation устраняет известные deterministic path failures.
- Durable cumulative object count/total stored bytes и egress billing quota не входят в SESSION-0022; реализованы per-object и resumable in-progress/retained-byte limits.
- MIME allowlist ограничен небольшим безопасным набором; `application/octet-stream` не подтверждает фактический format и всегда скачивается как attachment.
- Signed URL содержит token и tenant tuple в query. CDN/logging deployment обязан redaction query tokens и не должен игнорировать query string в cache key.
- Реальный MinIO/S3 network integration и upstream Linux integration tests требуют отдельного CI environment с object-store credentials/native `fs-xattr` support.
- Metadata schema v2 ужесточает input path limits, но не удаляет существующие v1 rows с более длинными путями; такие legacy rows требуют отдельной reconciliation/migration политики при наличии реальных данных.

## Следующая рекомендуемая сессия
- `SESSION-0023`: реализовать transactional outbox/changefeed foundation для Realtime поверх SQLite writes.
