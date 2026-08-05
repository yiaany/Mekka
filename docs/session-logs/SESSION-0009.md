# SESSION-0009: REST mutations

## Результат
COMPLETED

## Что сделано
- Добавлены `POST`, `PATCH` и `DELETE` для `/rest/v1/{table}`; `POST` с `Prefer: resolution=merge-duplicates` выполняет single-row upsert по primary key.
- Добавлен mutation AST и SQLite compiler для `INSERT`, `UPDATE`, `DELETE` и primary-key `UPSERT`. Идентификаторы берутся только из schema manifest, а значения передаются через bound parameters.
- Каждая mutation требует валидный `Idempotency-Key`. Запись ответа хранится транзакционно в `_mekka_idempotency`, scoped полным tenant tuple и actor; повтор с тем же payload возвращает исходный ответ, с другим payload возвращает `409`.
- `PATCH` и `DELETE` сначала выбирают затрагиваемые policy-rewritten rows в той же SQLite transaction, ограничивают их серверным cap, затем проверяют policy для old/new values и выполняют изменения по primary key.
- Добавлены `Prefer: return=minimal` (default) и `Prefer: return=representation`; representation фильтруется select field policy и не раскрывает запрещенные поля.
- Bulk JSON insert/upsert разрешен только с capability `data:bulk`; unbounded `PATCH`/`DELETE` также требуют эту capability. Bulk write ограничен `maxRows` и атомарен.
- Обновлены OpenAPI и compatibility matrix.

## Upstream
- PostgREST: approved clone `C:\Users\ilyaa\AppData\Local\Temp\opencode\postgrest-v14.16`, tag `v14.16`, commit `673bbbf291d5a3b6bda65cf5cf7c340f858a0531`; verified 3 August 2026. License: MIT, copyright (c) 2014 Joe Nelson and (c) 2019 Steve Chavez.
- Изучены `docs/references/api/preferences.rst`, `docs/references/api/tables_views.rst` и `docs/references/api/resource_representation.rst` для write return modes, resolution preference, primary-key upsert и JSON request semantics.
- supabase-js: cloned `https://github.com/supabase/supabase-js.git` into `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-js-v2.106.2`, tag `v2.106.2`, commit `a5f09cf9a0a8c2744464a8505333ab3136e3f290`; verified 3 August 2026. License: MIT, copyright (c) 2020 Supabase.
- Изучены `packages/core/postgrest-js/src/PostgrestQueryBuilder.ts` и `PostgrestTransformBuilder.ts` для default minimal return, `return=representation` and upsert client contract.
- Upstream source and tests were not copied or vendored; attribution files are therefore not introduced into the product tree.

## Архитектурные решения
- Idempotency record и business mutation находятся в одной SQLite transaction. Это исключает duplicated committed write for a successfully persisted key.
- Upsert conflict target намеренно ограничен primary key, чтобы не принимать arbitrary client-selected unique constraints.
- Update/delete first load policy-authorized old rows, then validate each resulting new row before issuing a primary-key DML statement. This avoids applying a check policy only after a write.
- `return=representation` needs select authorization: mutation response is treated as a data-read boundary, not as an implicit bypass of field policy.

## Измененные файлы
- `apps/gateway/src/app.ts`: mutation HTTP endpoints, idempotency, transactional preflight, capabilities, policies and return modes.
- `apps/gateway/src/openapi.ts`: OpenAPI paths for mutations.
- `apps/gateway/COMPATIBILITY.md`: supported and unsupported REST mutation subset.
- `apps/gateway/test/gateway.test.ts`: HTTP integration and security regressions.
- `packages/query-ast/src/index.ts`: mutation AST construction and input validation.
- `packages/sqlite-compiler/src/index.ts`: bound mutation compiler.
- `packages/sqlite-compiler/test/sqlite-compiler.test.ts`: mutation compiler coverage.
- `packages/policy-engine/src/index.ts`: update/delete policy rewrites fetch visible preflight rows independently of mutation field allowlist.

## Безопасность
- Full tenant headers, authenticated context and resolved project must agree before mutation routing.
- Mass assignment is denied by field policies; representation is separately field-filtered.
- Old-row `using` and new-row `check` policy verification occurs before every write.
- Unbounded mutation and JSON-array bulk paths are deny-by-default without a live tenant-scoped `data:bulk` capability.
- SQL injection is prevented by manifest-derived quoted identifiers and bound values; public errors remain stable and omit database detail.
- Idempotency scope includes organization/project/environment/branch/generation and actor, preventing cross-tenant or cross-actor replay.

## Проверки
- `bun test apps/gateway/test/gateway.test.ts`: PASSED, 9 tests.
- `bun test packages/sqlite-compiler/test/sqlite-compiler.test.ts`: PASSED, 7 tests.
- `bun run check`: PASSED: format check, lint, typecheck, 47 tests, build and health smoke test.
- `git diff --check`: PASSED.

## Совместимость
- Supported: JSON object insert, filtered update/delete, primary-key single-row upsert, `return=minimal`, `return=representation`, `resolution=merge-duplicates`, idempotent replay.
- Supported with capability: JSON-array insert/upsert, unbounded update/delete.
- Unsupported: arbitrary `on_conflict`, `resolution=ignore-duplicates`, `return=headers-only`, `missing=default`, bulk patch payloads, RPC, nested writes and embedding.
- SQLite behavior is not presented as PostgreSQL RLS or full PostgREST parity.

## Ограничения и риски
- Write execution uses the StorageAdapter transaction interface; unlike the injected read executor, it does not yet expose a per-statement cancellation/deadline primitive.
- Idempotency records currently have no retention/TTL job; production deployment needs bounded durable cleanup and quota accounting.
- Preflight and writes are atomic on the current SQLite writer. A distributed/libSQL adapter must prove equivalent transaction isolation in its conformance suite.
- Mutation response byte cap is not independently enforced yet; only row cap is applied. Large permitted returned rows need incremental/byte-bounded serialization in a follow-up.

## Следующая рекомендуемая сессия
- `SESSION-0010`: migrations and backups, including persisted idempotency table migration/retention policy and supported snapshots.
