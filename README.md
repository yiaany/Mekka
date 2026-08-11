<div align="center">
  <img src="docs/assets/mekka-readme-logo.png" alt="Mekka" width="112" />

  # MEKKA

  **THE BACKEND THAT DOESN'T NEED A FLEET.**

  Data, Auth, Storage, Realtime, Studio, and safe agent access on top of a database you can still
  understand.

  [![CI](https://github.com/yiaany/mekka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiaany/mekka/actions/workflows/ci.yml)
  ![Bun](https://img.shields.io/badge/Bun-1.3.14-242424?style=flat-square&logo=bun&logoColor=fff)
  ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=fff)
  ![SQLite](https://img.shields.io/badge/data-SQLite--native-0f80cc?style=flat-square&logo=sqlite&logoColor=fff)
  ![MCP](https://img.shields.io/badge/MCP-scoped-090909?style=flat-square)
  ![License](https://img.shields.io/badge/license-Mekka%20Business%202.0-090909?style=flat-square)
</div>

```bash
npx mekka
```

That command downloads the project, installs it, starts the backend, and opens Studio at
`http://127.0.0.1:8082`.

No external database. No Docker compose file full of services you did not ask for. No afternoon lost
to getting the dashboard, Auth, Storage, and Realtime to agree with each other.

<p align="center">
  <img src="docs/assets/studio/table-editor.jpg" alt="Mekka Studio table editor running against a local SQLite project" width="100%" />
  <sub>This is the current Studio running against a real local project.</sub>
</p>

## Why This Exists

Supabase solved a real problem: it made a serious backend available to people who did not want to
assemble one from scratch. I like that idea. I do not like that the answer still ends with a fairly
large PostgreSQL stack for projects that mostly need tables, users, files, subscriptions, and a decent
admin screen.

Mekka keeps those useful surfaces and changes the center of gravity.

Today, the center is Bun and SQLite. The database is an ordinary file. The backend is a small set of
TypeScript services. Studio ships with the project. An AI agent can inspect the system without being
handed a production database password.

That is the bet:

> **Supabase proved that developers want a backend platform. Mekka is proving they don't need the
> platform weight.**

This is not a PostgreSQL compatibility project wearing a new logo. If your application depends on
native PostgreSQL RLS, a large extension catalog, ranges, arrays, stored procedures, or exact PostgREST
behavior, use PostgreSQL. Supabase is probably the better choice today.

If you want a backend that starts locally in one command, stays understandable, and gives agents a
safer way to make changes, that is the problem Mekka is built to solve.

## What Already Works

Mekka is not a landing page for a future product. The current repository includes:

- a typed Data API over SQLite;
- table, row, column, and index management;
- migrations with schema compare-and-swap checks;
- verified checkpoints before destructive schema changes;
- Auth sessions, JWT/JWKS, OAuth, refresh rotation, and administrative user management;
- local and S3-compatible object storage;
- signed reads, resumable uploads, checksums, quotas, and reconciliation;
- transactional changefeeds, Realtime channels, Broadcast, and Presence;
- disposable preview branches with guarded promotion;
- an embedded Studio;
- scoped MCP access for AI agents;
- a Supabase JS-compatible Data API subset.

The important word is **subset**. Unsupported behavior is rejected explicitly. Mekka does not quietly
pretend that SQLite is PostgreSQL and hope the difference never matters.

Compatibility details live here:

- [`apps/gateway/SUPABASE_DATA_COMPATIBILITY.md`](apps/gateway/SUPABASE_DATA_COMPATIBILITY.md)
- [`apps/gateway/COMPATIBILITY.md`](apps/gateway/COMPATIBILITY.md)
- [`apps/sqlite-meta/COMPATIBILITY.md`](apps/sqlite-meta/COMPATIBILITY.md)

## The Agent Write Path

Giving an agent read access is useful. Giving it an unrestricted production SQL connection is lazy.

Mekka uses a longer path on purpose:

```text
prompt
  -> short-lived scoped token
  -> isolated preview branch
  -> migration and validation
  -> exact SQL review
  -> one-time approval
  -> production promotion
```

Read access is the default. A write token lasts no longer than five minutes and is bound to the full
tenant identity:

```text
organization / project / environment / branch / generation
```

When write access is enabled, the agent works in a disposable preview. It does not receive a hidden
production execute scope. Mekka records the migration artifact, exact SQL, schema hashes, and whether
the operation is destructive. Studio approval produces a short-lived secret tied to that exact
artifact. Promotion consumes the secret once and checks the production schema again before applying
anything.

An agent can still make a bad change. The point is that the bad change lands in its preview first.

<details>
<summary><strong>MCP configuration example</strong></summary>

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

## How It Is Put Together

The current local stack has one public Studio endpoint and one loopback backend. A normal request
moves through authentication, tenant checks, bounded parsing, policy enforcement, prepared SQL,
idempotency, and audit.

```text
Client / Studio / MCP
          |
          v
authentication + limits
          |
          v
tenant-bound capability check
          |
          v
typed query or migration artifact
          |
          v
schema and policy validation
          |
          v
prepared SQLite statement
          |
          v
result + audit + metrics
```

There are a few rules that show up throughout the codebase:

- authentication happens before authorization;
- tenant-sensitive checks use the complete tenant tuple;
- user values are bound parameters, not interpolated SQL;
- identifiers come from validated schema metadata;
- mutation bodies, rows, messages, uploads, and queues are bounded;
- retries use durable idempotency instead of wishful thinking;
- secrets and SQL values do not belong in logs;
- an unsupported operation fails closed.

The architecture is deliberately less magical than the average backend platform. That makes it
easier to test and much easier to explain when something goes wrong.

## Studio

Studio is the control surface for the parts of the backend people use every day: tables, SQL, Auth,
Storage, agent grants, previews, and approvals.

<table>
  <tr>
    <td width="50%"><img src="docs/assets/studio/sql-editor.jpg" alt="Mekka SQL editor" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-users.jpg" alt="Mekka Auth users administration" /></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/studio/agent-access.jpg" alt="Mekka Agent Access controls" /></td>
    <td width="50%"><img src="docs/assets/studio/auth-providers.jpg" alt="Mekka Auth provider settings" /></td>
  </tr>
</table>

Studio began as a private fork of Supabase Studio. The upstream code remains under Apache License 2.0,
with provenance recorded in [`apps/studio/UPSTREAM.md`](apps/studio/UPSTREAM.md) and the reproduced
license in [`apps/studio/UPSTREAM_LICENSE`](apps/studio/UPSTREAM_LICENSE).

## Run It

Node.js 20 or newer is required. Git is optional. If Git is unavailable, the CLI downloads the GitHub
archive over HTTPS.

```bash
npx mekka
```

Use a different destination directory if you want:

```bash
npx mekka my-app
```

Inside an existing checkout, the command reuses installed dependencies when possible, builds the core
packages, and starts the current project. Pass `--install` to force dependency installation.

For repository development:

```bash
bun install --frozen-lockfile
bun run dev
```

The local services are:

| Service | Address | What it does |
| --- | --- | --- |
| Studio | `127.0.0.1:8082` | Browser UI and same-origin API |
| sqlite-meta | `127.0.0.1:3001` | Data, Auth, branches, approvals, and MCP backend |

Runtime state is stored under `apps/studio/.local/` and ignored by Git and Docker contexts.

<details>
<summary><strong>Production process</strong></summary>

The supported production shape is intentionally small: expose Studio through a trusted reverse proxy,
keep the backend on loopback, and persist one data directory.

```bash
bun run build

MEKKA_STUDIO_ACCESS_TOKEN="replace-with-a-random-token" \
MEKKA_AUTH_SESSION_SECRET="replace-with-a-random-secret" \
MEKKA_PUBLIC_URL="https://mekka.example.com" \
NEXT_PUBLIC_SITE_URL="https://mekka.example.com" \
SQLITE_META_DATA_DIRECTORY="/absolute/path/to/mekka-data" \
bun run --cwd apps/studio start:production
```

`MEKKA_STUDIO_ACCESS_TOKEN` must contain at least 24 characters. The session secret must contain at
least 32 random characters. Configure production email with `MEKKA_RESEND_API_KEY` and
`MEKKA_AUTH_EMAIL_FROM`.

Terminate TLS at the reverse proxy. Back up the persistent directory. Test the restore, not just the
backup command.

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

Self-hosting does not make software secure by itself. The repository currently enforces several useful
boundaries, but a production deployment still needs monitoring, tested backups, deployment hardening,
and an independent review.

Current guarantees include:

- Agent Access is invalidated by logout, password reset, expiry, or session deletion.
- Public SQL is a constrained, single-statement subset.
- Internal tables, PRAGMA, arbitrary DDL, and transaction control are blocked from the SQL editor.
- Destructive schema changes require a verified checkpoint.
- Production promotion checks authorization and schema state inside the mutation lock.
- Unexpected failures become sanitized error envelopes without stack traces.
- Object reads verify provider key, length, and SHA-256 against stored metadata.
- Signed object grants are tenant-bound, version-bound, read-only, and expiring.

See [`SECURITY.md`](SECURITY.md) for private vulnerability reporting and
[`docs/runbooks/`](docs/runbooks/) for recovery procedures.

## Where Mekka Goes Next

SQLite is the starting point, not the ceiling.

The next engine is libSQL/Turso. The useful version of that work is not “accept a remote URL.” Mekka
needs remote writes, local replicated reads, explicit consistency behavior, provider-backed preview
databases, scoped credentials, and failure tests that cover the ugly moments between “request sent” and
“response received.”

After libSQL is stable, PGlite becomes the PostgreSQL-shaped option. That track is for teams that need
JSONB, PostgreSQL semantics, or pgvector without operating a PostgreSQL server for every local project
and preview environment.

The sequence matters:

1. Keep the local SQLite core fast and boring.
2. Add libSQL remote and replicated modes without breaking it.
3. Finish the failure, migration, branch, and Studio paths.
4. Add server-side PGlite as a separate engine.
5. Add JSONB and pgvector where the engine actually supports them.
6. Build Mekka Cloud around autosuspend, preview databases, and engine choice.

What is implemented now:

- Bun + SQLite data plane;
- embedded Studio;
- Auth, Storage, Realtime, branches, and MCP;
- guarded agent promotion.

What is planned, not shipped:

- production libSQL/Turso adapter;
- embedded replica routing;
- managed Turso clones and credentials;
- PGlite runtime;
- pgvector support;
- hosted Mekka Cloud;
- general plugin SDK;
- multi-region orchestration.

There are deliberately no fake checkmarks next to roadmap work. When an engine passes the same storage,
migration, branch, security, and failure contracts as the local core, it can carry production traffic.
Not before.

> **The endgame is simple: Supabase-scale usefulness without Supabase-scale machinery.**

## Repository Map

```text
apps/
  gateway/             REST, Storage, Realtime, compatibility, MCP mount
  health-service/      Independent service and health example
  mcp/                 Agent resources, tools, and mutation workflow
  sqlite-meta/         SQLite, Auth, branches, approvals, Agent grants
  studio/              React control surface and production server

packages/
  auth-core/           Sessions, JWT/JWKS, OAuth, refresh rotation
  branch-core/         Preview lifecycle and guarded promotion
  migration-engine/    Migration artifacts, checkpoints, restore
  policy-engine/       Row and field authorization
  protocol/            Tenant identity, capabilities, errors
  query-ast/           Validated Data API query representation
  realtime-core/       Changefeeds, channels, Broadcast, Presence
  schema-manifest/     Stable SQLite schema contracts
  sqlite-compiler/     Prepared SQLite statement compiler
  storage-core/        SQLite adapter and object storage
  studio-domain-sdk/   Typed Studio/backend boundary
```

## Development

The repository uses Bun `1.3.14` and strict TypeScript.

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start Studio and sqlite-meta |
| `bun run test` | Run the core Bun tests |
| `bun run test:workspaces` | Run workspace suites |
| `bun run test:studio:fork` | Run Studio integration assertions |
| `bun run lint` | Run Biome lint checks |
| `bun run typecheck` | Typecheck core project references |
| `bun run typecheck:studio` | Typecheck Studio and route contracts |
| `bun run build` | Build packages and production Studio |
| `bun run smoke:studio:production` | Exercise the production Studio path |
| `bun audit` | Check dependencies for known advisories |
| `bun run check` | Run the complete repository gate |

Contributions should stay focused. Add tests for success and failure paths, update the public contract
when behavior changes, and do not commit credentials, local databases, production data, private prompts,
or agent transcripts. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

The full source is visible under the **Mekka Business License 2.0**. Individuals may inspect, modify,
test, and learn from it. Qualifying small organizations receive an additional grant to use Mekka in
their own products.

The license does not give a large company or cloud vendor permission to rebrand this repository and
sell it back as a competing hosted backend. If someone wants to build a cloud business on Mekka, that
requires a commercial agreement.

See [`LICENSE.md`](LICENSE.md) for the terms that actually control.
