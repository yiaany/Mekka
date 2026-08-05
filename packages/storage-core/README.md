# @mekka/storage-core

SQLite metadata and object-provider boundary for the Mekka data plane.

`openStorageAdapter` accepts only `:memory:` or a database path contained in an explicit approved directory. It configures and verifies `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, and a bounded `busy_timeout` when opening each connection.

The SQL adapter exposes one-statement parameterized execution and synchronous atomic transactions. It rejects caller-controlled PRAGMA, transaction-control, `ATTACH`/`DETACH`, `VACUUM`, and multiple SQL statements.

`createObjectStorageCore` adds tenant-isolated buckets and object metadata over an `ObjectProvider`. The complete organization/project/environment/branch/generation tuple is present in metadata keys and physical provider prefixes. Actor operations pass through a policy hook; the default policy denies all access. Object listing uses the distinct `object:list` action rather than treating pathless object reads as permission to enumerate metadata. `getPolicySummary` returns effective booleans only after bucket-read authorization.

Object mutations use explicit metadata states:

- `pending_put`: provider success has not been confirmed;
- `ready`: provider size and SHA-256 checksum were confirmed and the object is visible;
- `pending_delete`: deletion is hidden from reads and must be retried or reconciled.

`ObjectProvider.get(key, maxBytes)` is an explicitly bounded read returning defensive copies of metadata and body bytes. `createLocalObjectProvider` stores objects below one approved directory with traversal protection, reversible base64url segment encoding, atomic exclusive publish, and bounded file reads. `createS3ObjectProvider` uses one configured S3-compatible physical bucket, conditional create, checksum metadata, post-write `HEAD` verification, bounded `GetObjectCommand` streaming, and SHA-256 verification of the downloaded bytes. Provider credentials and provider keys remain outside object read results. Call `ObjectProvider.close()` during service shutdown.

`ObjectStorageCore.getObject` performs the normal `object:read` policy check and independently verifies provider key, size, body length, and SHA-256 against persisted ready-object metadata. Returned body bytes are defensive copies. Canonical bucket, object path, and prefix normalization helpers are exported for transport adapters. New object inputs are limited to 180 UTF-8 bytes per logical path segment and 384 UTF-8 bytes for the complete logical object path. These provider-neutral limits apply equally to standard and resumable uploads before policy, metadata reservation, or provider access.

Signed read grants are optional and configured inside storage-core with `signedReadGrants`. Secrets must contain at least 32 bytes. Issuance first performs the ordinary `object:read` policy check and binds grant format version, key id, complete tenant tuple, bucket, canonical path, exact object version, read-only action, and expiry. Verification uses HMAC-SHA256 and `timingSafeEqual`; redemption accepts only the opaque `VerifiedReadGrant` produced by the configured authority, checks the caller-supplied target against every bound claim, and reads without rerunning actor policy. The authority supports one current and one previous key, allowing a minimal rotation window. Public origins and HTTP URL construction remain gateway concerns.

SQLite metadata schema v2 adds a persisted resumable upload subset through `createResumableUpload`, `getResumableUpload`, `appendResumableUpload`, `abortResumableUpload`, and `cleanupExpiredResumableUploads`. Sessions bind the complete tenant and actor, declare one fixed upload length, content type, idempotency key, expiry, and canonical target. Repeating creation with the same identity and target returns the original non-expired session; a newly computed transport expiry does not create an idempotency conflict. Appends are sequential and require the exact offset. Chunks and reads are bounded by core limits; per-tenant non-expired session count and reserved bytes are quota-controlled while each retained BLOB exists. Reaching the declared length moves the session from `uploading` to `finalizing`, writes through the existing idempotent object path, and then conditionally marks it `complete`. Finalizing sessions cannot be aborted; completed sessions can be aborted to release their retained metadata and BLOB without deleting the object. Finalization can be retried after interruption or an ambiguous provider response. Schema v2 tightens validation for new object paths without deleting or rewriting schema v1 data; reads of legacy rows whose provider keys cannot be represented may surface an infrastructure error.

Initialization transactionally migrates schema v1 to v2 without rewriting bucket or object rows. Unknown and future versions fail closed.

`reconcileBucket` completes confirmed pending operations and reports missing, mismatched, and orphan provider objects. It does not delete orphans automatically. Bucket deletion fails closed while either metadata or provider objects remain.

Operational assumptions and limits:

- the local provider root is private service state and is not writable by tenants or unprivileged host users;
- logical path segments are capped at 180 UTF-8 bytes, which base64url-encode to at most 240 bytes for the local provider;
- complete logical object paths are capped at 384 UTF-8 bytes, and the S3 provider independently rejects keys above 1024 UTF-8 bytes;
- resumable session and byte quotas count every non-expired session, including completed sessions, until abort or expiry;
- completed resumable sessions retain their bytes until explicit abort or expiry cleanup;
- reconciliation reports are informational snapshots and can become stale during concurrent deletion.

HTTP endpoints and Studio remain adapter concerns. Deferred upload length, concatenation, parallel or multipart upload, the full TUS protocol, transformations, public downloads, move/rename, batch deletion and unbounded listing are intentionally out of scope.

## Upstream provenance

No upstream source code is vendored. Supabase Storage v1.68.4 concepts and AWS SDK provenance are recorded in `UPSTREAM.md`.
