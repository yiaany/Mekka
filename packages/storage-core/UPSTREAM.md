# Upstream provenance

## Supabase Storage

- Repository: `https://github.com/supabase/storage`
- Tag: `v1.68.4`
- Commit: `7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`
- Verified: 5 August 2026
- Repository license: Apache-2.0, copyright 2019 Supabase
- NOTICE file: not present at the pinned commit

Inspected scope:

- `src/storage/backend/adapter.ts`
- `src/storage/backend/file.ts`
- `src/storage/backend/secure-path.ts`
- `src/storage/backend/s3/adapter.ts`
- `src/storage/storage.ts`
- `src/storage/object.ts`
- bucket, object, orphan, file-backend, S3, and TUS tests

Adapted concepts only: provider boundary, tenant-prefixed physical keys, object metadata separation, traversal regression tests, idempotent provider operations, explicit orphan inspection, and the fixed-length sequential-offset model used by resumable uploads. The resumable implementation is an intentionally small TUS-inspired subset, not a copy or claim of protocol compatibility.

No source from Supabase Storage v1.68.4 (`7c0f313a088a97f114dc3ba20b12f0014fa7f0ba`) was copied or vendored. The inspected repository is licensed Apache-2.0. PostgreSQL repositories, PostgreSQL RLS, HTTP routes, upstream TUS source, deferred length, concatenation, parallel uploads, events, branding, and cloud configuration were not transferred.

The pinned repository `LICENSE` is authoritative and contains Apache-2.0. Its root `package.json` still declares `ISC`; this mismatch was recorded rather than silently resolved in favor of package metadata.

## AWS SDK S3 client

- Package: `@aws-sdk/client-s3`
- Version: `3.1023.0`
- License: Apache-2.0
- Usage: S3-compatible provider transport only

The dependency is pinned exactly. No AWS SDK source is copied into this repository.
