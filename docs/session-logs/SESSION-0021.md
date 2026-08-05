# SESSION-0021: Storage core

## Результат
COMPLETED

## Что сделано
- Расширен `@mekka/storage-core`: добавлены project-isolated buckets, object metadata и versioned metadata schema `v1` поверх существующего SQLite `StorageAdapter`.
- Добавлен `ObjectProvider` contract с typed errors, retryability, idempotent `put`/`delete`, `head`, bounded-prefix `list` и lifecycle `close`.
- Добавлен local provider с approved root, reversible base64url encoding каждого path segment, traversal/Unicode validation, defensive body copy и atomic exclusive publish через hard link.
- Добавлен S3-compatible provider на pinned `@aws-sdk/client-s3`: один physical bucket, tenant-prefixed keys, conditional `If-None-Match: *`, checksum metadata, post-write `HEAD` verification и typed throttling/infrastructure errors.
- Реализован bucket CRUD и bounded object metadata API. Полный tenant tuple хранится в каждом primary/foreign key и включен в physical object prefix.
- Реализована metadata state machine `pending_put -> ready` и `ready -> pending_delete`: публично успешным и видимым считается только `ready`.
- Реализован reconciliation contract для завершения подтвержденных pending operations и отчетов `retry_put`, `retry_delete`, `provider_missing`, `provider_mismatch`, `orphan_provider_object`.
- Добавлен deny-by-default `StoragePolicyHook`; без явной policy implementation любая bucket/object operation запрещена.
- Добавлены bucket/object quotas, bounded lists, stable object versions, content SHA-256 и idempotency-key conflict detection.
- Добавлена transactional bootstrap migration metadata schema `v1`, existing-data/idempotency test и fail-closed отказ от неизвестной будущей версии.

## Upstream
- Repository: `https://github.com/supabase/storage`, tag `v1.68.4`, commit `7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`, commit date 4 августа 2026 года.
- Repository `LICENSE`: Apache-2.0, copyright 2019 Supabase; `NOTICE` отсутствует. Root `package.json` pinned commit по-прежнему указывает `ISC`; за authoritative license принят repository `LICENSE`, mismatch явно записан в provenance.
- Временный clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-storage-v1.68.4`.
- Изучены backend adapter, file/S3 implementations, secure path, bucket/object orchestration, TUS boundary и bucket/object/orphan/file-backend tests.
- Извлечены только concepts/contracts: provider boundary, tenant-prefixed keys, metadata/provider separation, traversal tests, idempotent operations и orphan inspection. Source upstream не копировался и не vendor-ился.
- PostgreSQL repository/RLS, HTTP routes, events, TUS implementation, branding и cloud configuration не переносились.
- Product dependency: `@aws-sdk/client-s3@3.1023.0`, Apache-2.0, exact pin; source dependency не копировался.
- Подробности сохранены в `packages/storage-core/UPSTREAM.md`.

## Архитектурные решения
- Logical buckets являются metadata resources; local/S3 providers используют один controlled root/physical bucket и tenant-scoped prefixes вместо выдачи provider credentials или создания caller-controlled physical buckets.
- Object metadata становится `ready` только после provider operation и проверки key/size/SHA-256. Ambiguous provider success остается `pending_put` и завершается reconciliation.
- Delete сначала скрывает metadata как `pending_delete`, затем выполняет идемпотентный provider delete. Provider failure не восстанавливает видимость и безопасно повторяется reconciliation.
- Delete запрещен для `pending_put`, чтобы concurrent upload не создал untracked orphan после удаления metadata.
- Bucket delete fail-closed проверяет и metadata rows, и provider prefix; orphan objects не удаляются автоматически.
- Local provider кодирует logical segments, чтобы Windows drive-relative/reserved/trailing-dot aliases не отображали разные logical keys в один filesystem path.
- Caller-owned `Uint8Array` копируется до первого `await` в core и provider boundaries, поэтому mutation после вызова не меняет проверенный payload.
- Metadata migration additive и выполняется одной SQLite transaction; failed bootstrap откатывается целиком. Новая версия требует отдельной migration session.

## Измененные файлы
- `packages/storage-core/src/object-provider.ts`: provider contract и typed errors.
- `packages/storage-core/src/local-object-provider.ts`: secure local provider.
- `packages/storage-core/src/s3-object-provider.ts`: S3-compatible provider.
- `packages/storage-core/src/object-storage.ts`: buckets, object metadata state machine, policy hook, reconciliation, quotas и schema version.
- `packages/storage-core/src/index.ts`: public exports object-storage layer.
- `packages/storage-core/test/object-storage.test.ts`: adapter contract, tenant, policy, race, orphan, quota, migration и failure tests.
- `packages/storage-core/package.json`, `packages/storage-core/tsconfig.json`: protocol/AWS dependencies и project reference.
- `packages/storage-core/README.md`: contract, states, trust assumptions и out-of-scope.
- `packages/storage-core/UPSTREAM.md`: pinned provenance и license review.
- `package.json`: object-storage suite добавлен в root test command.
- `bun.lock`: exact S3 dependency graph.

## Безопасность
- Bucket/object lookup, uniqueness, foreign keys и provider prefixes используют organization/project/environment/branch/generation; cross-tenant и reused-generation reads возвращают not found.
- Policy evaluation mandatory и deny-by-default; policy exception не открывает доступ.
- Bucket names и object paths нормализуются; запрещены traversal, absolute/backslash paths, empty/dot segments, controls, NUL и unpaired surrogates.
- SQL templates внутренние и parameterized; user-controlled prefix экранируется для `LIKE ... ESCAPE`.
- Local publish не перезаписывает existing key при concurrent race; S3 create использует provider-side precondition.
- Concurrent identical retries возвращают один committed result; changed payload/path с reused idempotency key получает conflict.
- Provider credentials отсутствуют в public contracts, metadata и tests.
- Final focused review не нашел известных Critical/High issues в измененном path.

## Проверки
- `npm ci --ignore-scripts` в upstream clone: FAILED, expected Windows platform rejection для `fs-xattr@0.4.0`.
- `npm ci --ignore-scripts --force` в upstream clone: PASSED для временного review environment; npm сообщил 17 vulnerabilities в полном upstream dependency graph, который не включен в product runtime.
- `$env:PGRST_JWT_SECRET='01234567890123456789012345678901'; node --env-file=.env.sample node_modules/vitest/vitest.mjs run --config vitest.unit.config.ts src/storage/backend/file.test.ts`: PASSED, 26 upstream tests.
- `bun test packages/storage-core/test/storage-adapter.test.ts packages/storage-core/test/object-storage.test.ts`: PASSED, 17 tests.
- `bun run check`: PASSED, format check, lint, typecheck, 98 tests, build и health smoke.
- `git diff --check`: PASSED.
- `bun audit`: FAILED repo-wide, 31 advisories в существующих `studio`, `auth-core` и UI dependency paths; новых advisories в `@mekka/storage-core -> @aws-sdk/client-s3` path отчет не показал.

## Совместимость
- Поддерживаются local filesystem и S3-compatible providers через собственный provider contract.
- Bucket/object model Supabase-inspired, но не заявляет HTTP или `storage-js` compatibility.
- Не поддерживаются upload/download HTTP, signed URLs, multipart/TUS, transformations, CDN, public object serving и Studio.
- S3 verification доверяет configured provider сохранять bytes согласованно с Mekka checksum metadata; независимое скачивание и повторное hash каждого upload не выполняется.

## Ограничения и риски
- Reconciliation является informational snapshot и может устареть при concurrent delete; automatic orphan deletion намеренно отсутствует.
- Local provider root должен быть private service state без write access у tenants/unprivileged host users; privileged host tampering находится вне этого boundary.
- Local encoded segment ограничен filesystem-safe длиной; слишком длинный logical segment получает explicit non-retryable provider error.
- S3 integration проверена contract test с fake client; реальный MinIO/S3 network integration требует deployment credentials/endpoint и остается следующей integration environment проверкой.
- Repo-wide `bun audit` содержит Critical/High advisories вне SESSION-0021. Они требуют отдельной security/dependency session и не были исправлены unrelated refactor.

## Следующая рекомендуемая сессия
- `SESSION-0022`: реализовать authenticated upload/download HTTP, signed URL expiry и object policy evaluation поверх готового storage-core.
