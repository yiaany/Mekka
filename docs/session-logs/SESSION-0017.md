# SESSION-0017: Better Auth foundation

## Результат
COMPLETED

## Что сделано
- Добавлен `@mekka/auth-core` с Better Auth SQLite store для полного tenant tuple: organization, project, environment, branch и generation.
- Auth store физически расположен отдельно от application branch database. Публичный service boundary отдает только tenant-bound issuer/audience и Better Auth request handler.
- Добавлен `AuthSecretStore`: auth service не читает `process.env` и не принимает raw secret; session secret приходит только из server-side secret store.
- Better Auth SQLite migrations применяются до публикации service. Повторное открытие того же store выполняет migrations идемпотентно.
- Production и preview stores имеют разные пути. Preview создается пустым либо получает явно переданные synthetic users только в таблице `user`; accounts, sessions и credentials не копируются.
- Добавлены integration tests для project isolation, preview isolation, migration idempotency и Better Auth handler health route.

## Upstream
- Better Auth: `https://github.com/better-auth/better-auth`, tag `v1.6.10`, commit `698678bcd08e0552661f9ae306b031674e588a2c`, MIT. Проверено 4 августа 2026 года.
- Upstream временно клонирован в `C:\Users\ilyaa\AppData\Local\Temp\opencode\better-auth-v1.6.10-pnpm`.
- Изучены Bun SQLite Kysely dialect, migration API, context initialization и internal adapter/session tests.
- Используется опубликованный пакет `better-auth@1.6.10` и его migration/handler APIs. Upstream source code не копировался, поэтому отдельные LICENSE/NOTICE files в product tree не требуются.

## Архитектурные решения
- Store path включает весь tenant tuple и auth mode. Это исключает routing collision между projects, branches и reused generations.
- `issuer` и `audience` также включают полный tuple; следующая сессия JWT/JWKS сможет использовать эту binding как единственный source of truth.
- Better Auth получает прямой `bun:sqlite` database, чтобы его официальный Kysely adapter создал Bun dialect. Передача `{ db: database, type: "sqlite" }` запрещена: она обходила dialect construction и ломала migration introspection.
- Preview mode не клонирует production store. Synthetic users не создают password, provider token, account или session records.

## Измененные файлы
- `packages/auth-core/src/index.ts`: service boundary, tenant-bound SQLite store, Better Auth migrations, binding ledger и preview synthetic users.
- `packages/auth-core/test/auth-core.test.ts`: project/preview isolation, migration and handler conformance tests.
- `packages/auth-core/package.json`, `packages/auth-core/tsconfig.json`, `packages/auth-core/README.md`: package configuration, workspace integration and provenance.
- `package.json`, `tsconfig.json`, `bun.lock`: auth-core workspace, dependency and root test/project references.

## Безопасность
- Auth persistence недоступен Data API: package не exposes database adapter or raw SQLite handle.
- Неполный или invalid tenant tuple отвергается существующим protocol parser до выбора store path.
- Different project/branch/generation и preview/production mode получают distinct paths, issuer и audience; нет fallback на shared store.
- Production credentials и sessions не копируются в preview. Synthetic preview identities не имеют account/session/token records.
- Session secret не передается в public API, browser or logs and не считывается из `process.env` внутри auth service.

## Проверки
- `bun test packages/auth-core/test/auth-core.test.ts`: PASSED, 3 tests.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `bun run typecheck`: PASSED.
- `bun run test`: PASSED, 75 tests.
- `bun run build`: PASSED.
- `bun run smoke:health`: PASSED.
- `git diff --check`: PASSED.
- `pnpm install --frozen-lockfile` в чистом upstream clone: PASSED. Использован pinned upstream package manager `pnpm@10.30.2` и его `pnpm-lock.yaml`.
- `pnpm build` в upstream clone: PASSED, 20 workspace packages. Сборка нужна, чтобы Vitest разрешал internal workspace exports в published `dist` paths.
- `NODE_OPTIONS=--experimental-sqlite pnpm exec vitest run packages/better-auth/src/db/internal-adapter.test.ts packages/better-auth/src/context/init.test.ts` в upstream clone: PASSED, 38 tests. Node `v24.18.0` предоставляет experimental `node:sqlite`, который требуется upstream suite.

## Совместимость
- Supported: Better Auth `v1.6.10` server handler and SQLite migration lifecycle for isolated project and preview stores.
- Deliberate scope limits: email/password, OTP, OAuth, JWT/JWKS, refresh rotation, management UI and Supabase `/auth/v1` compatibility are absent.
- Upstream SQLite adapter/context suite passed after installation through upstream's pinned pnpm workflow and Node SQLite runtime flag.

## Ограничения и риски
- The current request handler is server-only; HTTP routing, rate limiting, login flows and token issuance are deliberately deferred to SESSION-0018 and SESSION-0019.
- Auth SQLite store lifecycle currently has no durable control-plane registry, backup workflow or branch TTL cleanup; branch lifecycle is deferred to SESSION-0027.

## Следующая рекомендуемая сессия
- `SESSION-0018`: email/password registration, login, one-time verification/reset flows and refresh-token lifecycle over this isolated Better Auth store.
