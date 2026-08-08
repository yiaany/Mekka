# Core capability matrix

Verified on 6 August 2026. This matrix is the current product contract for the completed Core Engine slices; it does not promise PostgreSQL or full Supabase parity.

| Surface | Supported | Explicitly unsupported / deferred | Primary contract |
| --- | --- | --- | --- |
| Storage | Tenant-isolated buckets, local and S3-compatible providers, checksummed bounded reads, resumable upload subset, signed read grants, reconciliation | Public downloads, transforms, multipart/parallel uploads, full TUS, rename/move, unbounded listing | `packages/storage-core/README.md` |
| Realtime | Transactional SQLite journal, Phoenix JSON subscriptions, resume cursor/ack, policy-projected delivery, bounded Broadcast and Presence in one Bun runtime | Filters, column select, wildcard schemas/tables, binary framing, REST/replay Broadcast, distributed coordinator | `packages/realtime-core/README.md`, `docs/realtime-protocol-matrix.md` |
| Branches | Local SQLite schema-only preview, separate preview Auth/credential lifecycle, one validated migration, schema-CAS promotion, restore point, durable retries and TTL cleanup | Managed Turso adapter, divergent data merge, production data copying, multiple dependent migrations in one preview lifecycle | `packages/branch-core/README.md`, `docs/engine-capabilities/branching.md` |
| MCP | Tenant-bound read resources/tools and preview-only mutation workflow with Studio approval, promotion step-up and durable local audit ledger | Direct production SQL, row-data access, credential/token passthrough, automatic approval, embedded OAuth issuer | `apps/mcp/README.md` |
| Connect Analyzer | Capability-gated, read-only sandbox scan; Next.js/Vite React and package-manager detection; env-name/conflict detection; deterministic integration plan | Applying patches, GitHub App access, provider secret writes, repository code execution | `packages/onboarding-core/README.md`, `docs/connect-analyzer.md` |

All tenant-sensitive operations require the complete `organization_id / project_id / environment_id / branch_id / generation` identity. Unsupported behavior must return an explicit error rather than silently approximating another system's semantics.
