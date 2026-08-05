# SESSION-0014: Studio Quick Setup

## Результат
PARTIAL

## Что сделано
- Добавлен `@mekka/onboarding-core`: typed idempotent provisioning state machine для organization/project, region, template и выбранных modules.
- Новый project получает безопасные defaults: только явно выбранные modules, ограниченный allowlist регионов и templates, publishable API connection contract без server secret.
- Ресурс становится `ready` только после первого health check. При ошибке выполняется cleanup, connection details удаляются и failed resource не публикуется как доступный.
- Повторная отправка с тем же idempotency key возвращает исходный результат; изменение request с тем же key отклоняется как conflict. Retry допускается только владельцу failed provisioning.
- Studio Quick Setup доступен по `/onboarding` в Next и TanStack runtime; экран показывает статус, recovery retry, URL/publishable key snippet и переход к advanced settings.
- В `Studio Domain SDK` добавлен session-only onboarding client. Он intentionally не принимает publishable credential для control-plane mutation и фильтрует любые неожиданные server-secret поля provider response.
- Добавлен same-origin proxy `/api/platform/onboarding/*` с method/path/idempotency allowlist и request abort propagation.

## Upstream
- Approved pinned fork: `https://github.com/supabase/supabase`, tag `self-hosted/v0.7.1`, commit `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`, Apache-2.0.
- Новый upstream clone не требовался: commit Studio fork не менялся с SESSION-0012/0013.
- Изученный scope: существующие wizard/layout patterns, Pages/TanStack route wrappers, restricted fork routing и Studio Domain SDK boundary.
- Upstream code не копировался; Quick Setup state machine, proxy и UI являются Mekka code. License и provenance сохранены в `apps/studio/UPSTREAM_LICENSE` и `apps/studio/UPSTREAM.md`.

## Архитектурные решения
- `OnboardingRepository.claimIdempotency` является атомарной persistence boundary для `(actor, idempotency key)`: это исключает гонку между параллельными create requests; контрольная транзакция и placement/secret-store implementations не подменяются неявными in-memory fallbacks в runtime.
- First health check находится в provisioning state machine до publication connection details, а не выполняется клиентом после success.
- Browser получает только API URL и publishable key. Service credential отсутствует в public DTO, SDK и UI.
- Proxy forwards only Authorization, correlation ID and idempotency key, не пересылает cookies, arbitrary headers или server credentials.

## Измененные файлы
- `packages/onboarding-core/*`: provisioning contract, state machine, Elysia adapter, tests и documentation.
- `packages/studio-domain-sdk/*`: typed session-only onboarding client и contract test.
- `apps/studio/components/interfaces/Onboarding/QuickSetupWizard.tsx`: Quick Setup UI, status/retry и connection screen.
- `apps/studio/pages/onboarding.tsx`, `apps/studio/routes/onboarding.tsx`: Next/TanStack routes.
- `apps/studio/pages/api/platform/onboarding/[...path].ts`: constrained Studio backend proxy.
- `apps/studio/lib/fork-routing.ts`, `apps/studio/tests/fork/*`, `apps/studio/routeTree.gen.ts`: allowlist and fork smoke coverage.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace/test wiring.

## Безопасность
- Idempotency key предотвращает повторное создание при retry и conflict при reuse с другим payload.
- Failed provisioning очищается до publication и не возвращает URL/key, предотвращая доступный orphan resource.
- Actor ownership проверяется для inspect/retry flow; HTTP errors используют public stable codes и не возвращают provider error/stack trace.
- Client DTO и UI не содержат service-role/server secret; SDK regression test проверяет игнорирование лишнего secret field provider response.
- Input allowlists и bounds применяются к names, region, template, modules, record ID и idempotency key.

## Проверки
- `bun install --ignore-scripts`: PASSED.
- `bun test packages/onboarding-core/test/onboarding-core.test.ts packages/studio-domain-sdk/test/studio-domain-sdk.test.ts`: PASSED, 13 tests.
- `bun run test:studio:fork`: PASSED.
- `bun run test`: PASSED, 68 tests.
- `bunx tsc --build --pretty false`: PASSED.
- `bun run typecheck:studio`: PASSED.
- `bun run format:check`: PASSED.
- `bun run lint:studio`: PASSED with 2171 existing upstream warnings and zero errors.
- `git diff --check`: PASSED.
- `bun run build:tanstack` in `apps/studio` with 900-second timeout: PASSED. Vite compile/prerender completed, then the built server smoke returned `200` for `/api/get-utc-time`.

## Совместимость
- Studio remains a private Apache-2.0 derivative; onboarding uses Mekka control-plane contracts, not Supabase Cloud project creation endpoints.
- Quick Setup supports `empty`, `saas`, `marketplace`, `chat`, `mobile` and `import` declarations; template materialization is delegated to the provider provisioner.
- Billing checkout, GitHub Connect, full Auth configuration and actual Advanced Settings surfaces remain out of scope.

## Ограничения и риски
- Нет подключенной durable control-plane repository, real placement provisioner, secret-store integration или deployed Studio backend. The package exposes mandatory integration boundaries but cannot create real cloud resources by itself.
- Browser smoke against authenticated deployment is unavailable because no configured `STUDIO_BACKEND_API_URL`/control-plane service exists in this workspace.
- No deployed authenticated control-plane/browser smoke was available. Local TanStack production build and server boot smoke now pass.
- Cleanup failure is intentionally fail-closed, but requires a durable reconciler/job queue in the control plane to retry physical cleanup.

## Следующая рекомендуемая сессия
- Подключить `OnboardingRepository` к durable control-plane catalog и `OnboardingProvisioner` к placement/secret store, затем провести authenticated Studio-to-control-plane browser smoke с recovery after injected health failure.
