# Session Prompts: порядок разработки

## Как использовать

В новую coding-сессию передавай три файла:

1. `MASTER_PROMPT_RU.md`.
2. `LITEBASE_YC_STRATEGY_RU.md`.
3. Один `session-prompts/SESSION-XXXX.md`.

Выполняй сессии по порядку. Пропуск допустим только если dependency уже реализована и подтверждена тестами. После каждой сессии агент создает `docs/session-logs/SESSION-XXXX.md`.

Перед каждой новой сессией переводи ее фактические зависимости в `READY`. Если предыдущая сессия завершилась `PARTIAL/BLOCKED`, сначала создай repair-session, а не строй следующий слой поверх неизвестного состояния.

## Upstream rule

Если в Session Prompt указан repository, агент должен:

- клонировать его во временную директорию;
- проверить LICENSE и pin tag/commit;
- изучить релевантный component/path и tests;
- извлечь только указанный scope;
- сохранить attribution/NOTICE;
- записать repository и commit в Session Log.

Нельзя бесконтрольно копировать весь upstream monorepo в продукт.

## Roadmap

### Foundation и Data API

1. `SESSION-0001_REPOSITORY_FOUNDATION.md` — monorepo, CI и инженерная база.
2. `SESSION-0002_TENANT_PROTOCOL.md` — tenant identity, errors и shared protocol.
3. `SESSION-0003_STORAGE_ADAPTER.md` — SQLite StorageAdapter и connection invariants.
4. `SESSION-0004_SCHEMA_MANIFEST.md` — introspection и versioned schema manifest.
5. `SESSION-0005_QUERY_PARSER.md` — parser PostgREST filters в typed AST.
6. `SESSION-0006_SQLITE_COMPILER.md` — safe SQLite SELECT compiler.
7. `SESSION-0007_POLICY_ENGINE.md` — deny-by-default row/field policies.
8. `SESSION-0008_REST_SELECT.md` — production REST SELECT endpoint.
9. `SESSION-0009_REST_MUTATIONS.md` — insert/update/delete/upsert.
10. `SESSION-0010_MIGRATIONS_BACKUPS.md` — migration artifacts, checkpoints и restore.
11. `SESSION-0011_SQLITE_META.md` — management API таблиц и колонок.

### Studio

12. `SESSION-0012_STUDIO_FORK.md` — private fork Supabase Studio.
13. `SESSION-0013_STUDIO_DOMAIN_SDK.md` — adapter boundary Studio/backend.
14. `SESSION-0014_STUDIO_ONBOARDING.md` — organization/project Quick Setup.
15. `SESSION-0015_STUDIO_TABLE_EDITOR.md` — создание/изменение таблиц.
16. `SESSION-0016_STUDIO_ROWS_SQL.md` — row grid и безопасный SQL Editor.

### Auth

17. `SESSION-0017_AUTH_FOUNDATION.md` — Better Auth persistence и project isolation.
18. `SESSION-0018_AUTH_EMAIL.md` — registration/login/OTP/reset.
19. `SESSION-0019_AUTH_OAUTH_JWKS.md` — OAuth, JWT/JWKS и rotation.
20. `SESSION-0020_STUDIO_AUTH.md` — Auth management в Studio.

### Storage и Realtime

21. `SESSION-0021_STORAGE_CORE.md` — buckets, metadata и object adapter.
22. `SESSION-0022_STORAGE_UPLOADS.md` — upload/download/signed URLs/policies.
23. `SESSION-0023_STUDIO_STORAGE.md` — Storage UI.
24. `SESSION-0024_REALTIME_CHANGEFEED.md` — transactional outbox/change source.
25. `SESSION-0025_REALTIME_SUBSCRIPTIONS.md` — authenticated change subscriptions.
26. `SESSION-0026_REALTIME_BROADCAST_PRESENCE.md` — Broadcast и Presence.

### Branches и MCP

27. `SESSION-0027_BRANCH_LIFECYCLE.md` — preview branch, TTL и restore.
28. `SESSION-0028_MCP_READ_ONLY.md` — schema/logs/query read tools.
29. `SESSION-0029_MCP_MUTATIONS.md` — plan, preview, approval и promotion.

### Connect Project

30. `SESSION-0030_CONNECT_ANALYZER.md` — repository scanner и integration plan.
31. `SESSION-0031_CONNECT_GITHUB.md` — GitHub App, patch/PR и smoke test.

### Functions

32. `SESSION-0032_FUNCTIONS_RUNTIME.md` — sandbox runtime integration.
33. `SESSION-0033_FUNCTIONS_DEPLOYMENT.md` — deploy/invoke/secrets/cron/logs.

### Compatibility

34. `SESSION-0034_SUPABASE_DATA_COMPAT.md` — `supabase-js` CRUD compatibility.
35. `SESSION-0035_SUPABASE_AUTH_COMPAT.md` — `/auth/v1` compatible subset.
36. `SESSION-0036_SUPABASE_STORAGE_REALTIME_COMPAT.md` — client compatibility subset.

### Commercial cloud

37. `SESSION-0037_METERING_QUOTAS.md` — usage ledger, limits и entitlements.
38. `SESSION-0038_BILLING_PLANS.md` — Free/Default/Extended/Pro/Enterprise.
39. `SESSION-0039_TEAMS_AUDIT.md` — roles, invitations, approvals и audit.
40. `SESSION-0040_OBSERVABILITY_OPERATIONS.md` — telemetry, status и runbooks.
41. `SESSION-0041_PLACEMENT_FAILOVER.md` — leases, fencing и multi-node placement.
42. `SESSION-0042_FREE_TIER_AUTOSUSPEND.md` — pooled compute, suspend и abuse controls.
43. `SESSION-0043_SECURITY_RELEASE_GATE.md` — threat model и release security gate.
44. `SESSION-0044_PRODUCTION_LAUNCH.md` — launch checklist, subscription flow и YC demo.

## Правило дополнительных сессий

Если обнаружен Critical/High defect, создавай отдельный файл `SESSION-XXXXA_FIX_<NAME>.md` с одним regression fix. Не прячь большой repair внутри следующей feature-сессии.
