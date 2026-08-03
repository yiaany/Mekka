# SESSION-0022: Storage uploads и policies

## Цель
Реализовать upload/download/delete, signed URLs и resumable upload subset.

## Зависимости
- SESSION-0021.

## Upstream Sources
- Pinned `supabase/storage` clone из SESSION-0021.
- Извлечь protocol/validation ideas для standard и TUS uploads; не переносить Postgres RLS path.

## Scope
- HTTP endpoints, signed URL expiry и object policy evaluation.
- MIME/size limits, checksum и interrupted upload cleanup.
- CDN-friendly download response/redirect.

## Out of Scope
- Image transformations и client compatibility.

## Acceptance Criteria
1. Authorized upload/download/delete работают end-to-end.
2. Signed URL истекает и привязан к project/object/action.
3. Повтор upload/delete безопасен.

## Security
- Path traversal, MIME spoofing, oversized payload, cross-tenant и quota protection.

## Tests
- Integration/E2E uploads, expiry, interruption, policy deny и reconciliation.

## Deliverables
- Storage HTTP API, tests и Session Log.
