<div align="center">
  <img src="docs/assets/mekka-readme-logo.png" alt="Mekka" width="112" />

  # Mekka

  **KEEP THE BACKEND. FIRE THE FLEET.**

  Database, Auth, Storage, Realtime, Studio, and safe agent access in one Bun project.

  [![CI](https://github.com/yiaany/mekka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiaany/mekka/actions/workflows/ci.yml)
  ![Bun](https://img.shields.io/badge/Bun-1.3.14-242424?style=flat-square&logo=bun&logoColor=fff)
  ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=fff)
  ![SQLite](https://img.shields.io/badge/data-SQLite--native-0f80cc?style=flat-square&logo=sqlite&logoColor=fff)
  ![MCP](https://img.shields.io/badge/MCP-scoped-090909?style=flat-square)
  ![License](https://img.shields.io/badge/license-Mekka%20Business%202.0-090909?style=flat-square)
</div>

Run this:

```bash
npx mekka
```

Mekka downloads the project, installs it, builds it, starts the backend, and opens Studio at
`http://127.0.0.1:8082`.

You get a real database, user accounts, files, live updates, previews, approvals, and MCP. The local
stack does not need an external database or a pile of containers.

<p align="center">
  <img src="docs/assets/studio/table-editor.jpg" alt="Mekka Studio table editor running against a local SQLite project" width="100%" />
</p>

## The Pitch

Supabase taught the market to expect a database, Auth, Storage, Realtime, and a dashboard in the same
box. Good. Mekka takes that product shape and cuts the infrastructure bill underneath it.

The current release runs on Bun and SQLite. The database is a file you own. Studio ships in the repo.
Auth, Storage, Realtime, branches, and agent approvals run beside it. You can trace the request path
without drawing a map of twelve services first.

Deep PostgreSQL compatibility still belongs on PostgreSQL. Mekka rejects unsupported behavior instead
of faking it. Teams that need native RLS, stored procedures, ranges, or a large extension catalog
should use the real thing. Everyone else has been paying a Postgres tax for features their app never
touches.

> **Mekka is coming for the teams that want Supabase's product and none of its weight.**

## What Ships

- **Database.** Typed reads and writes, tables, columns, indexes, migrations, schema hashes,
  checkpoints, backup, and restore.
- **Auth.** Sessions, JWT/JWKS, email verification, password reset, OAuth, refresh rotation, and user
  administration.
- **Storage.** Local and S3-compatible providers, signed reads, checksums, resumable uploads, quotas,
  and reconciliation.
- **Realtime.** Transactional change events, resumable subscriptions, private channels, Broadcast, and
  Presence.
- **Branches.** Disposable database previews, schema validation, restore points, and guarded
  production promotion.
- **Studio.** Tables, SQL, users, providers, files, agent grants, previews, and approvals.
- **Agent Access.** Five-minute scoped MCP tokens with read access by default and preview-bound writes.
- **Supabase compatibility.** A tested `supabase-js` Data API subset for common CRUD flows.

The compatibility claim stops where the tests stop. Arrays, ranges, native PostgreSQL RLS, RPC,
arbitrary extensions, casts, and the full PostgREST surface are not supported today.

Read the exact contracts:

- [Data API compatibility](apps/gateway/SUPABASE_DATA_COMPATIBILITY.md)
- [Gateway compatibility](apps/gateway/COMPATIBILITY.md)
- [SQLite management API](apps/sqlite-meta/COMPATIBILITY.md)
- [Realtime protocol](docs/realtime-protocol-matrix.md)
- [Core capability matrix](docs/core-capability-matrix.md)

## Agent Writes Without Production Roulette

An AI agent should not need your production database password. Mekka gives it a short-lived token tied
to one organization, project, environment, branch, generation, and application session.

Read access works immediately. Write access opens a disposable preview.

```text
Agent
  -> one-hour scoped token
  -> isolated preview
  -> migration and validation
  -> exact SQL approval
  -> one-time production promotion
```

Mekka stores the migration artifact, SQL, schema hashes, and destructive-operation flag. Studio shows
the change before approval. The approval secret works once and only for that artifact. Promotion checks
the production schema again before it runs.

The agent can break its preview. Production stays behind a human decision and a schema check.

<details>
<summary><strong>MCP configuration</strong></summary>

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

## Studio

Studio manages the backend from one screen. The screenshots below come from the current project, not a
design mockup.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/studio/sql-editor.jpg" alt="Mekka SQL editor" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-users.jpg" alt="Mekka Auth users" /></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/studio/agent-access.jpg" alt="Mekka Agent Access" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-providers.jpg" alt="Mekka Auth providers" /></td>
  </tr>
</table>

Studio contains code derived from Supabase Studio under Apache License 2.0. Provenance and the
reproduced license live in [`apps/studio/UPSTREAM.md`](apps/studio/UPSTREAM.md) and
[`apps/studio/UPSTREAM_LICENSE`](apps/studio/UPSTREAM_LICENSE).

## Start Locally

Install Node.js 20 or newer, then run:

```bash
npx mekka
```

Choose a folder name if `mekka` is already taken:

```bash
npx mekka my-app
```

The CLI installs Bun when needed. Git is optional. Without Git, it downloads the GitHub archive over
HTTPS.

Inside an existing checkout:

```bash
bun install --frozen-lockfile
bun run dev
```

| Service | Address |
| --- | --- |
| Studio | `http://127.0.0.1:8082` |
| Backend | `http://127.0.0.1:3001` |

Local state stays in `apps/studio/.local/`.

## How A Request Runs

Every request carries the full tenant identity:

```text
organization / project / environment / branch / generation
```

The backend authenticates the caller before checking permissions. It resolves table and column names
through the schema manifest, binds user values as parameters, applies policy, and executes one prepared
statement.

```text
Client / Studio / MCP
          |
          v
Authentication and limits
          |
          v
Tenant capability check
          |
          v
Schema and policy validation
          |
          v
Prepared SQLite statement
          |
          v
Result, audit, and metrics
```

Mutation requests carry idempotency keys. Payloads, results, uploads, queues, and Realtime buffers have
hard limits. Errors do not include secrets, SQL values, or stack traces. Unsupported operations return
an explicit error.

## Repository

```text
apps/
  gateway/             Data, Storage, Realtime, compatibility, MCP mount
  health-service/      Health service example
  mcp/                 Agent resources, tools, and mutation workflow
  sqlite-meta/         Database management, Auth, branches, approvals
  studio/              Studio and production web server

packages/
  auth-core/           Sessions, JWT/JWKS, OAuth, token rotation
  branch-core/         Preview lifecycle and guarded promotion
  migration-engine/    Migration artifacts, checkpoints, restore
  policy-engine/       Row and field authorization
  protocol/            Tenant identity, capabilities, errors
  query-ast/           Validated Data API queries
  realtime-core/       Changefeeds, channels, Broadcast, Presence
  schema-manifest/     SQLite schema contracts
  sqlite-compiler/     Prepared SQLite statement compiler
  storage-core/        Database adapter and object storage
  studio-domain-sdk/   Typed Studio API client
```

## Next Engines

SQLite runs today. libSQL/Turso is next. PGlite follows after the libSQL release is stable.

The libSQL release will cover remote databases, embedded replicas, primary write routing, managed
preview databases, and scoped credentials. The PGlite track follows with isolated runtimes, JSONB, and
pgvector.

Those features remain roadmap work until their storage, migration, branch, security, and failure tests
pass.

> **WE'RE BUILDING THE REASON TO LEAVE SUPABASE.**

## Self-Hosting

Build the repository, set the server secrets, and start Studio:

```bash
bun run build

MEKKA_STUDIO_ACCESS_TOKEN="replace-with-a-random-token" \
MEKKA_AUTH_SESSION_SECRET="replace-with-a-random-secret" \
MEKKA_PUBLIC_URL="https://mekka.example.com" \
NEXT_PUBLIC_SITE_URL="https://mekka.example.com" \
SQLITE_META_DATA_DIRECTORY="/absolute/path/to/mekka-data" \
bun run --cwd apps/studio start:production
```

The backend stays on loopback. Put a trusted TLS reverse proxy in front of Studio and persist the data
directory. Run a restore before trusting a backup.

Docker builds are available:

```bash
docker build \
  --build-arg NEXT_PUBLIC_SITE_URL=https://mekka.example.com \
  --build-arg NEXT_PUBLIC_MEKKA_GATEWAY_URL=https://mekka.example.com \
  -f apps/studio/Dockerfile \
  -t mekka-studio .
```

## Development

Run the complete repository gate:

```bash
bun run check
```

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start Studio and the backend |
| `bun run test` | Run the core Bun tests |
| `bun run test:workspaces` | Run workspace test suites |
| `bun run test:studio:fork` | Run Studio integration tests |
| `bun run lint` | Run Biome lint checks |
| `bun run typecheck` | Typecheck core packages |
| `bun run typecheck:studio` | Typecheck Studio |
| `bun run build` | Build packages and Studio |
| `bun run smoke:studio:production` | Test the production Studio path |
| `bun audit` | Check dependency advisories |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## Support And Security

Use GitHub Issues for reproducible bugs, questions, and feature requests. Report vulnerabilities
privately through the process in [`SECURITY.md`](SECURITY.md).

Mekka is under active development. Reviewed paths have tests. A production deployment still needs
monitoring, verified backups, deployment hardening, and an independent security review.

## License

Mekka uses the **Mekka Business License 2.0**. Individuals may inspect, modify, test, and learn from
the source. Qualifying small organizations may use Mekka in their products under the additional grant.

Large companies and cloud providers may not repackage Mekka as a competing hosted backend without a
commercial agreement. [`LICENSE.md`](LICENSE.md) contains the terms.
