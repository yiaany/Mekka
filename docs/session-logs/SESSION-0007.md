# SESSION-0007: Policy engine v1

## Результат
COMPLETED

## Что сделано
- Добавлен пакет `@mekka/policy-engine` с versioned typed policy document для `select`, `insert`, `update` и `delete`.
- Public operation deny-by-default: отсутствующая table/action policy, неразрешенное поле, malformed policy или invalid manifest reference не дают доступ.
- Row predicates поддерживают typed `and`/`or` groups, negation, `eq`/`neq` и values `actor_id`/literal string. Rules одного action объединяются по OR.
- `rewritePolicyQuery` добавляет row predicate policy в validated Query AST для `select`, `update` и `delete` до SQLite compiler; projection `select=*` превращается в явный field allowlist.
- `simulatePolicy` проверяет concrete row для select/delete, new values для insert и old-row + input для update. Для mutation declared fields обязаны совпадать с input keys, поэтому запрещенный input нельзя скрыть укороченным field list.
- Добавлены field allow/deny, runtime/simulator parity, malformed policy, missing policy, cross-tenant и temporary SQLite CRUD integration tests.

## Upstream
- Проверен официальный `https://github.com/supabase/supabase`, tag `v1.26.05`, commit `23b55d63485e51919d1b4c05b03d33a9edc1f06d`, 3 августа 2026 года.
- License: Apache-2.0, copyright 2024 Supabase.
- Через GitHub API изучены `apps/studio/components/interfaces/Auth/Policies/`, включая `Policies.tsx`, `Policies.types.ts`, `Policies.utils.ts`, `PolicyEditor`, `PolicyReview`, `PolicySelection` и `RLSTester`, только как UX/reference для action-specific policies, templates, review и simulation surfaces.
- Временное shallow clone в `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-v1.26.05` не завершился в лимит времени из-за размера upstream monorepo; source upstream не использован, не copied и не vendor-ился. PostgreSQL RLS SQL не переносился, поэтому LICENSE/NOTICE upstream в продукт не добавлялись.

## Архитектурные решения
- Policy model намеренно SQLite-neutral и не генерирует SQL. Query rewriter работает только с existing-row predicates в AST, затем existing SQLite compiler сохраняет identifier and parameter boundary.
- Update authorization требует `using` для current row и `check` для merged new row; insert требует `check`; select/delete требуют `using`. Неполные rules fail closed как malformed policy.
- Field permissions собираются из action rules: allow обязателен, deny имеет приоритет. Hidden schema fields не могут быть policy fields, поскольку они не являются public API identifiers.
- Direct database access остается trusted admin path и не предоставляется policy engine или public client. Public mutation caller обязан вызвать simulator и выполнить mutation в той же transaction.

## Измененные файлы
- `packages/policy-engine/src/index.ts`: typed format, simulator, field authorization, AST rewriter, validation и stable errors.
- `packages/policy-engine/test/policy-engine.test.ts`: policy matrix, rewrite/compiler parity, cross-tenant and CRUD SQLite integration tests.
- `packages/policy-engine/package.json`, `packages/policy-engine/tsconfig.json`: workspace package configuration.
- `packages/policy-engine/README.md`: format, runtime contract, field and transaction boundaries.
- `package.json`, `tsconfig.json`, `bun.lock`: workspace integration, root test command, project reference и package resolution.

## Безопасность
- Без table/action policy public operation запрещена; нет fallback на trusted database connection.
- Actor predicates компилируются из authenticated `TenantContext` and never from client-supplied actor data; upstream Protocol validates the complete tenant tuple and capability binding.
- Select/update/delete query path получает mandatory row predicate before compilation, предотвращая cross-owner rows в public query path.
- Insert/update input проходят `check`; update проверяет merged resulting row. Input key set сверяется с declared field set, предотвращая field-list bypass.
- Policy references only visible manifest fields; unknown/hidden fields and malformed rules fail closed. The package emits no raw SQL.

## Проверки
- `bun test packages/policy-engine/test/policy-engine.test.ts`: PASSED, 5 tests.
- `bun run typecheck`: PASSED.
- `bun run format:check`: PASSED.
- `bun run lint`: PASSED.
- `git diff --check`: PASSED.

## Совместимость
- Это собственный policy format version `1`, inspired only by high-level RLS UX concepts; он не является PostgreSQL RLS implementation и не заявляет Supabase policy SQL compatibility.
- Поддерживаются scalar owner-style predicates над visible columns. Joins, subqueries, SQL functions, arbitrary expressions, roles, JWT claims beyond authenticated actor identity и column masking expressions не поддерживаются.

## Ограничения и риски
- Mutation execution adapter еще не существует: caller обязан materialize old row, run `simulatePolicy`, merge update input for `check`, and execute approved mutation atomically. Следующая REST mutation session должна закрепить эту sequence внутри одной transaction.
- Tenant isolation основывается на validated `TenantContext` и per-tenant storage routing, которые остаются внешними boundaries; policy v1 не добавляет tenant columns автоматически.
- Policy document persistence, audit history, schema migrations for policy changes, Studio editor и prompt-to-policy находятся вне scope.

## Следующая рекомендуемая сессия
- `SESSION-0008`: public REST select endpoint, который строит manifest, parses query, applies `rewritePolicyQuery`, compiles SQLite and enforces response limits.
