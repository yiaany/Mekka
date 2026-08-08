# Supabase Data compatibility provenance

## `supabase-js`

- Repository: `https://github.com/supabase/supabase-js`
- Release: `v2.111.0`
- Annotated tag object: `9a9d0ceab8cae23cba008cb50cda3775b01524cd`
- Commit: `97b58eb428556d768ae982c511fa10c4b7b8119f`
- Commit date: 28 July 2026
- License: MIT, copyright 2020 Supabase
- Review clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\supabase-js-v2.111.0`

Reviewed scope:

- `packages/core/postgrest-js/src/PostgrestQueryBuilder.ts` CRUD, count, columns and conflict request construction;
- `packages/core/postgrest-js/src/PostgrestTransformBuilder.ts` mutation representation and query transforms;
- `packages/core/postgrest-js/src/PostgrestFilterBuilder.ts` supported filter request shapes;
- `packages/core/postgrest-js/src/PostgrestBuilder.ts` status, error, count and JSON response parsing;
- basic/filter/transform tests and request examples relevant to the supported subset.

## PostgREST

- Repository: `https://github.com/PostgREST/postgrest`
- Release: `v14.12`
- Commit: `6200fbad58b99568c5124657ff43d4f6774c79fe`
- Commit date: 20 May 2026
- License: MIT, copyright Joe Nelson and Steve Chavez
- Review clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\postgrest-v14.12`

Reviewed scope:

- insert/update/delete/upsert specifications;
- range and exact-count headers/status;
- return representation/minimal preferences;
- conflict-target, uniform bulk-object and PostgREST error-shape fixtures.

No upstream backend code or tests were copied or vendored. Mekka owns the SQLite implementation, policy enforcement, tenant routing and explicit compatibility deviations.
