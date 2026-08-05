# SESSION-0012: Private Supabase Studio fork

## Результат
COMPLETED

## Что сделано
- Импортирован buildable private fork Supabase Studio в `apps/studio` вместе с минимальным workspace dependency closure.
- Studio жестко переведен в local-only mode: `IS_PLATFORM` равен `false` в Studio и `packages/common` и не переключается environment variables.
- Сохранен upstream UI; доступными product areas оставлены только Table Editor и SQL Editor.
- Navigation, command menu и direct routes ограничены единым fork allowlist. Unsupported project, account, organization, support, marketplace и integration routes перенаправляются в Table Editor в Next и TanStack runtimes.
- Добавлены neutral branding `Mekka`, metadata, manifests, favicon/logo paths, sign-in и global error states.
- Analytics, event tracking, Sentry initialization, incident/status integrations и hosted health checks отключены.
- Удалены automatic Supabase CLI release requests, hosted docs/AI/support commands и SQL template с внешним dbdev request и embedded JWT.
- Удалены well-known fallback values для `PG_META_CRYPTO_KEY`, `POSTGRES_PASSWORD` и `AUTH_JWT_SECRET`; эти значения теперь обязательны и fail closed.
- Добавлены fork assertions, provenance, Apache-2.0 license copy и upstream update runbook.

## Upstream
- Repository: `https://github.com/supabase/supabase`.
- Tag: `self-hosted/v0.7.1`.
- Commit: `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`.
- License: Apache-2.0, сохранена в `apps/studio/UPSTREAM_LICENSE`.
- Upstream `NOTICE` отсутствует на pinned commit.
- Provenance проверен 3 August 2026 и записан в `apps/studio/UPSTREAM.md`.

## Импортированные пути
- `apps/studio`.
- `packages/ai-commands`, `api-types`, `build-icons`, `common`, `config`, `dev-tools`.
- `packages/eslint-config-supabase`, `icons`, `pg-meta`, `shared-data`, `tsconfig`, `ui`, `ui-patterns`.
- Upstream `.env`, secrets, certificates, deployment state, caches и unrelated applications не импортировались.

## Архитектурные решения
- Исходные package names, database roles, schemas и protocol compatibility identifiers сохранены там, где они нужны импортированному коду; это не runtime branding и не Supabase Cloud coupling.
- Unsupported source pages остаются в дереве, потому что Next и TanStack migration wrappers зависят от общей структуры. Runtime guard закрывает их вместо удаления большого upstream surface.
- `/project/:ref/editor` и `/project/:ref/sql` являются единственными разрешенными project areas; `/` и `/project/:ref` в итоге перенаправляются в Table Editor.
- Command menu регистрирует только Table Editor, SQL Editor, snippets, layout navigation, theme и local context search commands.
- Runtime secrets не имеют sample/default credentials. Ошибка конфигурации обнаруживается до формирования connection string или выдачи JWT settings.

## Безопасность
- Telemetry component возвращает `null`, `useTrack()` является no-op, GTM/PostHog gated compile-time значением `IS_PLATFORM=false`.
- Next, edge, server и TanStack Sentry initialization отключены; оставшиеся compatibility capture calls не имеют DSN-backed runtime initialization.
- Incident banner/status endpoints постоянно возвращают `404`; Edge Functions status не выполняет внешний fetch.
- Удалены Vercel deployment IDs, сохраненные TLS private keys и hard-coded dbdev JWT.
- Secret scans не нашли `*.key`, concrete `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`, known JWT fallback, `SAMPLE_KEY` или прежний hosted health-check URL.
- `PG_META_CRYPTO_KEY`, `POSTGRES_PASSWORD` и `AUTH_JWT_SECRET` должны поступать из runtime secret store.

## Проверки
- `bun install --ignore-scripts`: PASSED.
- `bun run test:studio:fork`: PASSED.
- `bun run typecheck:studio`: PASSED.
- `bun run lint:studio`: PASSED с существующими upstream warnings, без errors.
- `bun run build:studio`: PASSED; Next production build compiled, generated 181 static pages и завершил finalization.
- `bun run check`: PASSED; format, root lint, typecheck, 54 tests, build и health smoke.
- `git diff --check`: PASSED.
- Production startup smoke: `/sign-in` returned `200` with title `Mekka`.
- Production startup smoke: `/project/local/storage/files` and `/account/me` returned `307` to `/project/local/editor`.
- Production startup smoke: `/project/default` returned `307` to `/project/default/editor`; following `/` redirects ended at `/project/default/editor` with `200`.

## Acceptance scans
- Runtime-visible Table/SQL shell uses Mekka branding; remaining Supabase strings are in blocked product areas, tests, compatibility code, package names, SQL roles or provenance documentation.
- Command-menu docs search and AI docs commands are not registered, so the default Supabase docs search endpoint is not reachable from the supported shell.
- SQL dbdev template and its external `api.database.dev` request were removed.
- Automatic Supabase CLI GitHub release requests were removed; `/api/cli-release-version` returns `404`.
- Unsupported screens are buildable upstream source but hidden from navigation and blocked in both routers.

## Ограничения и риски
- The imported upstream surface remains large and produces 2168 existing ESLint warnings, but zero lint errors. Future upstream updates must use the ratchet/update runbook rather than treating the current warning baseline as new Mekka code.
- Upstream Vitest suites require `jsdom`, which was intentionally not added for this import. Fork invariants use a typed Bun assertion script; Studio typecheck, lint, production build and startup smoke provide the acceptance coverage for this session.
- `next start` warns for `output: standalone`; production smoke used `.next/standalone/apps/studio/server.js`. Deployment packaging must include the generated static/public assets beside the standalone server.
- Table Editor and SQL Editor still target the imported Studio data contracts. Wiring them to the Mekka Studio Domain SDK is deferred to SESSION-0013.

## Следующая рекомендуемая сессия
- `SESSION-0013`: connect the supported Studio shell to Mekka gateway/sqlite-meta through a dedicated domain SDK and remove remaining PostgreSQL-only runtime assumptions from the enabled editors.
