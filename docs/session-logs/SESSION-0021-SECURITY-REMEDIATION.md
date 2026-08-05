# SESSION-0021 adjunct: Dependency security remediation

## Результат
COMPLETED

## Что сделано
- Обновлен и зафиксирован Bun dependency graph, чтобы устранить advisories, обнаруженные после `SESSION-0021` в существующих Studio, Auth и UI dependency paths.
- Root overrides закрепляют проверенные версии затронутых AI SDK, Sentry, Usercentrics, React, lodash, UUID и связанных transitive dependencies.
- `uuid` принудительно обновлен до `14.0.1`; runtime compatibility с `@usercentrics/cmp-browser-sdk@4.42.0` проверена в jsdom, а consent-state suite проверяет реальный package import path.
- TanStack Vercel function больше не зависит от pnpm-specific `.pnpm` layout при включении `libpg-query.wasm`.
- Добавлен regression test фактически экспортируемого TanStack Vercel config, а не только внутреннего helper value.

## Upstream
- Новые upstream source fragments не копировались.
- Использованы уже существующие npm packages и Bun lockfile; security remediation ограничена dependency resolution и deployment configuration.

## Архитектурные решения
- WASM inclusion использует package-manager-independent glob `../../node_modules/**/libpg-query/wasm/libpg-query.wasm`, который сохраняет package-relative boundary для Bun, pnpm и npm layouts.
- Regression test устанавливает `STUDIO_FRAMEWORK=tanstack`, заново импортирует `vercel.ts` и проверяет exported `config.functions['api/server.js'].includeFiles`.
- UUID override сохранен только после проверки реального Usercentrics ESM import в browser-like jsdom runtime. Одного успешного install или typecheck для такого transitive major override было бы недостаточно.
- Проверка `libpg-query` включает фактический WASM parse, поэтому конфигурационное исправление не опирается только на строковое сравнение glob.

## Измененные файлы
- `package.json`: security overrides, exact dependency pins и root `jsdom` для browser-runtime compatibility test.
- `bun.lock`: обновленный dependency graph с `uuid@14.0.1` и исправленными версиями advisories.
- `apps/studio/vercel.ts`: package-manager-independent inclusion для `libpg-query.wasm`.
- `apps/studio/vercel-config.test.ts`: test фактически экспортируемой TanStack Vercel function configuration.

## Безопасность
- `bun audit` больше не сообщает известных vulnerabilities в текущем lockfile.
- Устранен deployment availability risk: Vercel function не должна терять externalized WASM из-за предположения о pnpm store layout в Bun workspace.
- Major UUID override не принят вслепую: Usercentrics импортируется с реально resolved `uuid@14.0.1` в jsdom, а consent decisions продолжают проходить fail-closed tests.
- Изменения не ослабляют consent parsing, CSP, tenant authorization или runtime secret boundaries.

## Проверки
- `bun audit`: PASSED, `No vulnerabilities found`.
- `bun run --cwd apps/studio vitest --run vercel-config.test.ts`: PASSED, 2 tests.
- `bun run --cwd apps/studio vitest --root ../.. --run packages/common/consent-state.test.ts --environment jsdom`: PASSED, 27 tests.
- `bun -e "... import('@usercentrics/cmp-browser-sdk') ..."` из `packages/common`: PASSED, Usercentrics default export загружен в jsdom с forced `uuid@14.0.1`.
- `bun -e "... import('libpg-query/wasm'); parse('select 1') ..."` из `apps/studio`: PASSED.
- `bun run --cwd apps/studio eslint vercel.ts vercel-config.test.ts`: PASSED.
- `git diff --check`: PASSED.
- `bun run check`: PASSED после remediation; root format, lint, typecheck, tests, build и health smoke зеленые.
- `bun run build:studio`: PASSED с timeout 60 минут; Next compiled за 8.1 минуты, сгенерировал 182/182 страниц и завершил запись filesystem cache за 38.4 минуты.
- `bun run lint:studio`: FAILED из-за существующих upstream Studio violations вне dependency remediation scope; targeted changed-file ESLint проходит.

## Совместимость
- Workspace остается Bun-first и больше не требует pnpm-specific deployment layout для TanStack WASM packaging.
- `@usercentrics/cmp-browser-sdk@4.42.0` объявляет `uuid ^9.0.0`, но проверенный runtime path совместим с root override `uuid@14.0.1` в текущем browser-like environment.
- `libpg-query@17.6.0` продолжает загружать WASM и выполнять parse локально; фактическая Vercel deployment packaging требует platform build verification.

## Ограничения и риски
- Полный Studio lint сохраняет pre-existing upstream violations. Они не относятся к измененным dependency/config files и не исправлялись unrelated refactor.
- Glob проверен как exported config и локальный package layout, но окончательная доступность WASM внутри Vercel function bundle должна быть подтверждена deployment smoke test.
- Forced transitive major override остается compatibility assumption, покрытой текущими import и consent-state tests; при обновлении Usercentrics эти probes необходимо повторить.

## Следующая рекомендуемая сессия
- `SESSION-0022`: authenticated Storage upload/download HTTP и signed URLs; перед production deploy отдельно выполнить Vercel TanStack bundle smoke.
