# Branch Core

`@mekka/branch-core` owns the preview branch lifecycle and its durable control-plane catalog.

- Local SQLite branches are restored from one `VACUUM INTO` snapshot. User-table rows are removed before a schema-only immutable branch checkpoint, Auth store, or preview credential is published.
- Preview credentials and Auth stores are provisioned through required server-side boundaries; credential IDs are reserved before issuance, secrets are returned once, and raw tokens are never stored in the branch catalog. Issuers must make `issue`/`revoke` idempotent by the supplied credential ID.
- Promotion supports one validated migration artifact per preview lifecycle and replays it against the parent with compare-and-swap schema validation, a pre-mutation restore point, and durable idempotency state.
- TTL cleanup claims only expired preview rows identified by the full tenant tuple and generation. Production databases are never cleanup candidates.
- Parent database resolvers must serialize all production mutations through `withMutationLock`; checkpoint, CAS, and migration apply execute under that ownership boundary.
- `createProjectAuthPreviewStoreLifecycle` from `@mekka/auth-core` supplies the production preview Auth implementation. Credential revoke and Auth delete operations must be idempotent for crash recovery.
- Managed Turso branching is recorded as a verified provider capability, but no managed adapter is exposed until its API, token, polling, and deletion semantics have conformance tests.
