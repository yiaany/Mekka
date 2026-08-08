<div align="center">
  <img src="docs/assets/mekka-readme-logo.png" alt="Mekka" width="112" />

  # MEKKA

  **BACKEND INFRASTRUCTURE THAT FITS IN YOUR HEAD.**

  SQLite through Bun's native driver. Embedded Studio. Scoped Agent Access.

  `DATABASE` · `AUTH` · `STORAGE` · `REALTIME` · `STUDIO` · `SAFE AGENTS`

  [![CI](https://github.com/yiaany/mekka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiaany/mekka/actions/workflows/ci.yml)
  ![Bun](https://img.shields.io/badge/Bun-1.3.14-242424?style=flat-square&logo=bun&logoColor=fff)
  ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=fff)
  ![SQLite](https://img.shields.io/badge/data-SQLite--native-0f80cc?style=flat-square&logo=sqlite&logoColor=fff)
  ![MCP](https://img.shields.io/badge/MCP-scoped-090909?style=flat-square)
  ![License](https://img.shields.io/badge/license-Mekka%20Business%202.0-090909?style=flat-square)

  [Why Mekka](#why-mekka) · [Architecture](#architecture) · [Studio](#studio) · [Run it](#run-it) · [Security](#security)
</div>

<br />

<p align="center">
  <img src="docs/assets/studio/table-editor.jpg" alt="Mekka Studio table editor running against a local SQLite project" width="100%" />
  <sub>Real Studio. Real local SQLite project. No mockup.</sub>
</p>

---

## Less Platform. More Product.

Most products need **durable data, auth, files, realtime, and a control surface**. They do not need
PostgreSQL infrastructure as a lifestyle.

<table>
  <tr>
    <td width="33%" valign="top"><strong>SQLite-native</strong><br /><sub>Ordinary database files through Bun's native driver.</sub></td>
    <td width="33%" valign="top"><strong>One Studio</strong><br /><sub>Data, users, files, branches, and approvals in one place.</sub></td>
    <td width="33%" valign="top"><strong>Agents with limits</strong><br /><sub>Read by default. Preview first. Production only after approval.</sub></td>
  </tr>
</table>

> **Mekka is the Supabase killer for teams that need the product surfaces, not the PostgreSQL fleet.**

## Why Mekka

Supabase is broad by design. Mekka is deliberately smaller: keep the useful backend surface, remove
the machinery most projects never touch, and make agent safety part of the architecture.

| | **Mekka** | **Supabase** | **Plain SQLite** |
| --- | --- | --- | --- |
| Data plane | SQLite through Bun's native driver | PostgreSQL | SQLite |
| Studio | Bundled private fork | Hosted or self-hosted | Bring your own |
| Backend surface | Data, Auth, Storage, Realtime | Broad PostgreSQL platform | Database only |
| Agent access | Native scoped MCP | Configurable MCP | Application-defined |
| Write path | Preview → exact SQL → approval → CAS promotion | Configuration-dependent | Application-defined |
| Self-host shape | Bun/Node services + SQLite files | Multi-service Postgres stack | Embedded database |

**Choose Supabase** when deep PostgreSQL compatibility is the requirement.

**Choose Mekka** when shipping with less infrastructure is the requirement.

<details>
<summary><strong>Comparison notes and sources</strong></summary>

Mekka implements a selected `supabase-js` Data API subset. It does not claim parity for PostgreSQL
arrays, ranges, native RLS, extensions, casts, or every PostgREST feature.

Supabase references: [Database](https://supabase.com/docs/guides/database/overview),
[MCP Server](https://supabase.com/docs/guides/ai-tools/mcp), and
[Self-hosting](https://supabase.com/docs/guides/self-hosting).

</details>

## Safe Agent Changes

> Agents get room to work, not room to improvise in production.

```text
PROMPT → SCOPED TOKEN → ISOLATED PREVIEW → VALIDATION → EXACT SQL → APPROVAL → PRODUCTION
```

| **Read** | **Write** |
| --- | --- |
| Default capability: `mcp:read` | Requires explicit Studio opt-in |
| Maximum five-minute opaque token | Bound to a disposable preview branch |
| Full tenant identity attached | No production execute scope |
| Revoked with the originating session | One-time artifact-bound approval secret |

<details>
<summary><strong>See the complete trust chain</strong></summary>

1. Studio issues an opaque Agent Access token with a maximum five-minute lifetime.
2. The grant is bound to organization, project, environment, branch, generation, and auth session.
3. Write access creates an isolated preview instead of granting production execution.
4. Mekka records the migration artifact, exact SQL, schema hashes, and destructive-operation flag.
5. Studio approval issues a short-lived, one-time secret bound to that exact artifact.
6. Production promotion atomically consumes the secret and rechecks authorization and schema CAS.

An agent typo can damage its disposable preview. It cannot silently rewrite production.

</details>

<details>
<summary><strong>Universal MCP configuration</strong></summary>

```json
{
  "mcpServers": {
    "mekka": {
      "type": "http",
      "url": "https://mekka.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <temporary-agent-access-token>"
      }
    }
  }
}
```

</details>

## Architecture

Every request carries one unambiguous identity:

```text
organization / project / environment / branch / generation
```

```text
Developer / AI Agent
         │
         │ HTTPS + scoped five-minute token
         ▼
┌──────────────────────┐
│     MCP Gateway      │  body limits · rate limits
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│    Token Verifier    │  session · tenant · TTL
└──────────┬───────────┘
           │
     read  │  write opt-in
           │        └──────► isolated preview
           │                   │ plan · apply · test
           │                   ▼
           │              exact SQL approval
           ▼                   │
┌──────────────────────┐◄──────┘
│     sqlite-meta      │  manifest · compiler · audit
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│   SQLite Database    │  prepared statements
└──────────────────────┘
```

<details>
<summary><strong>Follow a normal query</strong></summary>

```text
Client / Studio / MCP
  → authentication
  → rate and size limits
  → tenant-bound capabilities
  → typed query or migration artifact
  → policy rewrite
  → prepared SQLite statement
  → storage adapter
  → response, metrics, and audit
```

</details>

## Studio

One control surface for the backend paths people actually use.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/studio/sql-editor.jpg" alt="Mekka SQL editor" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-users.jpg" alt="Mekka Auth users administration" /></td>
  </tr>
  <tr>
    <td align="center"><sub><strong>SQL EDITOR</strong></sub></td>
    <td align="center"><sub><strong>AUTH USERS</strong></sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/studio/agent-access.jpg" alt="Mekka Agent Access registration and token controls" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-providers.jpg" alt="Mekka authentication provider configuration" /></td>
  </tr>
  <tr>
    <td align="center"><sub><strong>AGENT ACCESS</strong></sub></td>
    <td align="center"><sub><strong>AUTH PROVIDERS</strong></sub></td>
  </tr>
</table>

## Built In

| **Surface** | **What ships** |
| --- | --- |
| **Data + SQLite** | Typed reads and mutations, tables, rows, indexes, migrations, schema diff, backup, and restore |
| **Auth + Storage** | Sessions, JWT/JWKS, OAuth, audit, local/S3 objects, signed reads, resumable uploads, and quotas |
| **Realtime + Branching** | Changefeeds, private channels, presence, preview snapshots, validation, restore points, and CAS promotion |
| **Studio + MCP** | Visual administration, read tools by default, preview mutations, exact-SQL approval, and production promotion |

## Run It

Four commands. Two local services. No external database to provision.

```bash
git clone https://github.com/yiaany/mekka.git
cd mekka
bun install --frozen-lockfile
bun run dev
```

Open **`http://127.0.0.1:8082`**.

| Service | Address | Purpose |
| --- | --- | --- |
| Studio | `127.0.0.1:8082` | Browser control surface and same-origin API |
| sqlite-meta | `127.0.0.1:3001` | Data, Auth, branches, approvals, and MCP backend |

Requires Bun `1.3.14`, Git, and a current browser. Local state lives in `apps/studio/.local/` and is
ignored by Git and Docker contexts.

<details>
<summary><strong>Production deployment</strong></summary>

The production shape is one public Studio endpoint, one loopback backend, and one persistent data
directory.

| Variable | Purpose |
| --- | --- |
| `MEKKA_STUDIO_ACCESS_TOKEN` | Protects Studio; minimum 24 characters |
| `MEKKA_AUTH_SESSION_SECRET` | Auth and Agent Access HMAC secret; minimum 32 random characters |
| `MEKKA_PUBLIC_URL` | Public origin used by Auth and MCP metadata |
| `NEXT_PUBLIC_SITE_URL` | Public browser origin baked into Studio |
| `SQLITE_META_DATA_DIRECTORY` | Absolute persistent data directory |
| `MEKKA_RESEND_API_KEY` | Server-only production email credential |
| `MEKKA_AUTH_EMAIL_FROM` | Verified Auth email sender |

```bash
bun run build

MEKKA_STUDIO_ACCESS_TOKEN="replace-with-a-random-token" \
MEKKA_AUTH_SESSION_SECRET="replace-with-a-random-secret" \
MEKKA_PUBLIC_URL="https://mekka.example.com" \
SQLITE_META_DATA_DIRECTORY="/absolute/path/to/mekka-data" \
bun run --cwd apps/studio start:production
```

Backend listeners remain loopback-only. Terminate TLS at a trusted reverse proxy, persist the data
directory, and test restores before storing valuable data.

</details>

<details>
<summary><strong>Docker build</strong></summary>

```bash
docker build \
  --build-arg NEXT_PUBLIC_SITE_URL=https://mekka.example.com \
  --build-arg NEXT_PUBLIC_MEKKA_GATEWAY_URL=https://mekka.example.com \
  -f apps/studio/Dockerfile \
  -t mekka-studio .
```

</details>

## Security

Self-hosted is a deployment model, not a security model.

| Boundary | Guarantee |
| --- | --- |
| Identity | Authentication precedes authorization; every check uses the full tenant tuple |
| Agent access | Read-only by default; writes stay preview-bound until explicit approval |
| SQL | User values are prepared parameters; public SQL is constrained and allowlisted |
| Secrets | Tokens, SQL values, provider credentials, and secrets are not logged |
| Mutations | Durable idempotency, audit outbox, bounded payloads, and schema CAS |
| Recovery | Destructive schema changes require a verified checkpoint |

See [`SECURITY.md`](SECURITY.md) for private vulnerability reporting and
[`docs/runbooks/`](docs/runbooks/) for recovery procedures.

<details>
<summary><strong>Additional security guarantees</strong></summary>

- Logout, password reset, expiry, and session deletion invalidate Agent Access.
- Mutation request bodies, MCP messages, query rows, and responses are bounded.
- Production promotion rechecks secret expiry inside the mutation lock.
- Unexpected errors become sanitized envelopes without stack traces.
- Identifiers resolve through the schema manifest instead of user-provided SQL fragments.

</details>

## Developer Reference

<details>
<summary><strong>Commands</strong></summary>

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start local Studio and sqlite-meta |
| `bun run test` | Run the core Bun test matrix |
| `bun run test:workspaces` | Run compatible workspace suites |
| `bun run test:studio:fork` | Run Mekka Studio integration assertions |
| `bun run lint` | Run Biome lint checks |
| `bun run typecheck` | Typecheck core project references |
| `bun run typecheck:studio` | Typecheck Studio and route contracts |
| `bun run build` | Build packages and production Studio |
| `bun run smoke:studio:production` | Exercise Studio, Auth, SQLite, MCP, approval, and promotion |
| `bun audit` | Check dependencies for known advisories |
| `bun run check` | Run the complete release gate |

</details>

<details>
<summary><strong>Repository map</strong></summary>

```text
apps/
  gateway/             REST, Storage, Realtime, compatibility, MCP mount
  health-service/      Independent health-service example
  mcp/                 Resources, tools, transport, mutation workflow
  sqlite-meta/         SQLite, Auth, branches, approvals, Agent grants
  studio/              React control surface and production server

packages/
  auth-core/           Sessions, JWT/JWKS, OAuth, refresh rotation
  branch-core/         Preview lifecycle and guarded promotion
  migration-engine/    Migration artifacts, checkpoints, restore
  policy-engine/       Row and field authorization
  protocol/            Tenant identity, capabilities, errors
  query-ast/           Validated Data API query representation
  realtime-core/       Changefeeds, channels, presence
  schema-manifest/     Stable SQLite schema contracts
  sqlite-compiler/     Prepared statement compiler
  storage-core/        SQLite adapter and object storage
  studio-domain-sdk/   Typed Studio/backend boundary
```

</details>

<details>
<summary><strong>Compatibility and upstream provenance</strong></summary>

Compatibility is tested, never assumed. Unsupported PostgreSQL behavior returns explicit errors.

- [`apps/gateway/SUPABASE_DATA_COMPATIBILITY.md`](apps/gateway/SUPABASE_DATA_COMPATIBILITY.md)
- [`apps/sqlite-meta/COMPATIBILITY.md`](apps/sqlite-meta/COMPATIBILITY.md)
- [`apps/studio/UPSTREAM.md`](apps/studio/UPSTREAM.md)

Mekka Studio contains code derived from Supabase Studio under Apache License 2.0. Upstream
provenance and the reproduced license remain in `apps/studio/UPSTREAM.md` and
`apps/studio/UPSTREAM_LICENSE`.

</details>

## Status And License

Mekka is under active development. Passing tests cover reviewed paths; production deployments still
require monitoring, backups, restore tests, and independent security review.

Source is available under the **Mekka Business License 2.0**. This is not an OSI-approved open-source
license. See [`LICENSE.md`](LICENSE.md) for the controlling terms.
