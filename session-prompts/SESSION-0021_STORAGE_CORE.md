# SESSION-0021: Storage core

## Цель
Создать project-isolated buckets и metadata layer поверх S3-compatible object storage.

## Зависимости
- SESSION-0002, SESSION-0003, SESSION-0007.

## Upstream Sources
- `https://github.com/supabase/storage`.
- Клонировать во временную директорию, проверить Apache-2.0 и pin commit.
- Изучить bucket/object API, S3 abstraction, TUS flows и tests; PostgreSQL repository/RLS не переносить.

## Scope
- Object provider interface и local/S3 adapter.
- Bucket CRUD, object metadata и policy hooks.
- Reconciliation contract между metadata и object provider.

## Out of Scope
- Upload HTTP, transformations и Studio.

## Acceptance Criteria
1. Buckets полностью изолированы по tenant tuple.
2. Metadata не считается успешной до согласованного object operation state.
3. Provider errors типизированы и retryable operations идемпотентны.

## Security
- Bucket/path normalization, no traversal и deny-by-default policy.

## Tests
- Adapter contract, cross-tenant, orphan/reconciliation и provider failure tests.

## Deliverables
- `storage-core`, provenance, tests и Session Log.
