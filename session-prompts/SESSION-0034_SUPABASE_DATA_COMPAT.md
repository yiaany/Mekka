# SESSION-0034: `supabase-js` Data API compatibility

## Цель
Поддержать измеряемый CRUD subset `supabase-js` заменой URL/key.

## Зависимости
- SESSION-0008, SESSION-0009.

## Upstream Sources
- `https://github.com/supabase/supabase-js` и `https://github.com/PostgREST/postgrest`.
- Клонировать оба repository, pin commits/tags и reference versions.
- Извлечь client contract tests/fixtures и PostgREST response semantics; backend code не копировать.

## Scope
- `from().select/insert/update/delete/upsert`, filters, order, range и return modes.
- Differential test harness против pinned reference Supabase stack.
- Versioned compatibility matrix и explicit deviations.

## Out of Scope
- RPC, deep embed, Postgres arrays/ranges/extensions и full-text parity.

## Acceptance Criteria
1. Supported calls дают compatible status/headers/body/errors.
2. Unsupported calls fail explicitly.
3. Matrix содержит полный reference tuple.

## Security
- Compatibility не обходит policies, limits и tenant checks.

## Tests
- Differential/contract suite, null/typing/Unicode deviations и regression corpus.

## Deliverables
- Compatibility adapter/package, matrix, tests и Session Log.
