# SESSION-0036: Supabase Storage/Realtime client compatibility

## Цель
Поддержать наиболее частые `supabase-js` Storage и Realtime client calls.

## Зависимости
- SESSION-0022, SESSION-0025, SESSION-0034.

## Upstream Sources
- `https://github.com/supabase/storage-js`, `https://github.com/supabase/realtime-js` и `https://github.com/supabase/supabase-js`.
- Клонировать/pin versions; извлечь client contracts/tests, не backend persistence.

## Scope
- Storage bucket/file upload/download/remove/signed URL subset.
- Realtime database-change subscribe/unsubscribe/reconnect subset.
- Versioned compatibility matrix.

## Out of Scope
- Every TUS option, image transforms, full Phoenix protocol и all Presence semantics.

## Acceptance Criteria
1. Supported calls работают через pinned clients.
2. Reconnect/duplicate semantics документированы.
3. Unsupported method fail-fast.

## Security
- Client compatibility не раскрывает service credentials и не обходит policies.

## Tests
- Client contract/e2e, expiry, reconnect, policy и error mapping.

## Deliverables
- Adapters, matrix, tests, provenance и Session Log.
