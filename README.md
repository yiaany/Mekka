<div align="center">
  <img src="apps/studio/public/img/mekka-logo.svg" alt="Mekka" width="88" />

  # Mekka

  **A compact, tenant-safe backend platform built for people and software agents.**

  SQLite data plane. Auth. Storage. Realtime. Studio. MCP. One explicit security model.

  [![CI](https://github.com/yiaany/mekka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiaany/mekka/actions/workflows/ci.yml)
  ![Bun](https://img.shields.io/badge/Bun-1.3.14-fbf0df?logo=bun&logoColor=000)
  ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)
  ![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=fff)
  ![License](https://img.shields.io/badge/license-Mekka%20Business%202.0-111827)
</div>

---

Mekka is a source-available backend-as-a-service for applications that need a modern control
surface without assigning a dedicated PostgreSQL cluster to every project. It combines a
SQLite-backed data plane with a web Studio, project-scoped authentication, object storage,
realtime primitives, Supabase-compatible data endpoints, and an MCP surface designed around
short-lived capabilities instead of unrestricted database credentials.

The same tenant identity is enforced across every entry point:

```text
organization / project / environment / branch / generation
```

If identity, authorization, schema, or routing is ambiguous, Mekka rejects the operation.

## What Ships

| Surface | Current capability |
| --- | --- |
| **Studio** | Local project dashboard, table editor, SQL workspaces, Auth administration, Storage management, and Agent Access installation. |
| **Data API** | Typed and policy-rewritten reads and mutations, bounded pagination, idempotency, OpenAPI metadata, and a Supabase-compatible REST surface. |
| **SQLite management** | Tables, columns, indexes, row editing, constrained SQL, migrations, destructive-operation checkpoints, and backup/restore runbooks. |
| **Auth** | Email/password registration, hashed email OTP verification, sessions, JWT/JWKS, refresh rotation, password reset, Google/GitHub OAuth, and admin audit events. |
| **Storage** | Buckets, local/S3 object providers, signed reads, resumable uploads, quotas, reconciliation, and tenant-aware authorization hooks. |
| **Realtime** | Changefeed subscriptions, private channels, broadcast, presence, bounded payloads, and policy-aware delivery. |
| **Branching** | Tenant-generation-aware branch lifecycle, preview isolation, migration proposals, validation, and guarded promotion workflows. |
| **MCP** | Streamable HTTP endpoint, protected-resource metadata, read tools/resources, tenant-bound capabilities, sanitized logs, and preview mutation workflows. |
| **Compatibility** | Selected Supabase client data behavior with explicit compatibility tests and documented unsupported semantics. |

## Design

```text
                  Browser / SDK / Agent
                           |
                    Studio and Gateway
                           |
          +----------------+----------------+
          |                |                |
       REST API          Auth             MCP
          |                |                |
          +-------- tenant context ---------+
                           |
                 capability verification
                           |
               typed AST + policy rewrite
                           |
                    SQLite compiler
                           |
          +----------------+----------------+
          |                |                |
       database         objects         changefeed
```

Mekka separates public protocols from storage execution. User-controlled values remain bound
parameters, identifiers resolve through schema metadata, privileged mutations require explicit
capabilities, and MCP never receives a raw database connection string.

## Technology

| Layer | Stack |
| --- | --- |
| Runtime | Bun 1.3.14, Node.js 22 for the Studio production image |
| Language | TypeScript, strict project references, ES modules |
| Web UI | React 19, TanStack Start/Router, Vite 8, Tailwind CSS 4 |
| Legacy rollback | Next.js Pages Router retained during the TanStack migration |
| Backend | Elysia, Web Standard Request/Response APIs |
| Data | SQLite, typed query AST, schema manifest, policy rewriter, SQLite compiler |
| Authentication | Better Auth runtime, JOSE JWT/JWKS, email OTP, OAuth providers |
| Agent protocol | Model Context Protocol SDK, Streamable HTTP transport |
| State and data fetching | Valtio, TanStack Query, React Hook Form, Zod |
| Editor and UI | Monaco Editor, Radix primitives, shared Mekka UI packages |
| Quality | Bun Test, Vitest, TypeScript, Biome, ESLint, production smoke tests |
| Delivery | GitHub Actions, multi-stage Docker image |

## Quick Start

### Requirements

- Bun `1.3.14`
- Git
- A current Chromium, Firefox, or Safari browser

### Install

```bash
git clone https://github.com/yiaany/mekka.git
cd mekka
bun install --frozen-lockfile
```

### Run the local platform

```bash
bun run dev
```

Open `http://127.0.0.1:8082`. The development command starts:

| Service | Address | Purpose |
| --- | --- | --- |
| Studio | `http://127.0.0.1:8082` | Browser control surface and same-origin API routes |
| SQLite metadata runtime | `http://127.0.0.1:3001` | Project data, Auth, and MCP backend |

Local state is stored under `apps/studio/.local/` and is ignored by Git.

### Verify the repository

```bash
bun run check
```

The full gate formats, lints, typechecks, tests, builds, starts the production Studio, exercises
health endpoints, and shuts the processes down.

## Configuration

Copy values from `apps/studio/.env.example` into an ignored local environment file. Never commit
the resulting file.

### Required for production

| Variable | Description |
| --- | --- |
| `MEKKA_STUDIO_ACCESS_TOKEN` | Random Studio access token, at least 24 characters. |
| `NEXT_PUBLIC_SITE_URL` | Public browser origin baked into the Studio build. |
| `MEKKA_PUBLIC_URL` | Public runtime origin used in Auth and MCP metadata. |
| `SQLITE_META_DATA_DIRECTORY` | Absolute persistent directory outside local development. |
| `MEKKA_AUTH_SESSION_SECRET` | Random server-side Auth secret; at least 32 characters. |

### Email verification

Local development uses an in-memory delivery sink and fills the six-digit code in Studio. The
verification-code endpoint is disabled outside `MEKKA_LOCAL_DEV=1`.

Production delivery uses Resend:

| Variable | Description |
| --- | --- |
| `MEKKA_RESEND_API_KEY` | Server-only Resend API key. |
| `MEKKA_AUTH_EMAIL_FROM` | Verified sender, for example `Mekka <auth@example.com>`. |

If production email is not configured, registration fails explicitly rather than reporting a
successful delivery that never happened.

### Public tenant identity

These values are routing metadata, not credentials:

```dotenv
NEXT_PUBLIC_STUDIO_ORGANIZATION_ID=org-local
NEXT_PUBLIC_STUDIO_ENVIRONMENT_ID=env-local
NEXT_PUBLIC_STUDIO_BRANCH_ID=branch-main
NEXT_PUBLIC_STUDIO_GENERATION=1
```

Every `NEXT_PUBLIC_*` variable is visible to the browser. Secrets belong only in server-side
variables or an external secret manager.

## Studio

### Table editor

The table editor creates and evolves SQLite tables through the schema-management API. Row reads
are paginated; mutations are idempotent and use manifest-validated identifiers.

### SQL editor

Pressing `+` allocates a unique in-memory SQL workspace and URL. Each tab retains its own query,
result, write opt-in, and metadata-only activity history until the tab is closed or the page is
reloaded. SQL text is not persisted to browser storage.

The constrained SQL endpoint currently allows:

- one statement per request;
- `SELECT`, `INSERT`, `UPDATE`, and `DELETE`;
- `SELECT` only with `LIMIT <= 200`;
- `UPDATE` and `DELETE` only with `WHERE`;
- only tables exposed by the current schema manifest.

DDL, PRAGMA, ATTACH, transactions, system tables, joins, subqueries, and multi-statement input are
rejected. Schema changes belong in the table editor and migration workflow.

### Application Auth

The Register / Sign in screen walks through user creation, email verification, and a real sign-in
check. Access and refresh tokens are not rendered into the DOM. A signed-in user can copy a
temporary Agent Access token without exposing the refresh token.

## Agent Access

Open **Agent Access** in the Studio header. Mekka provides:

- a universal HTTP client configuration for major MCP clients;
- the exact public `/mcp` endpoint;
- a separate opaque Agent Access token with a maximum five-minute lifetime;
- a server-created `mcp:read` capability bound to the token tenant;
- no database password or service-role key in the client configuration.

Example universal configuration:

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

The current remote flow intentionally uses an explicit two-step bearer configuration. A normal
application JWT is rejected by `/mcp`; Studio exchanges it for a separate, short-lived opaque
Agent Access token. Mekka does not claim
that the project Auth issuer is a complete third-party OAuth authorization server. Dynamic client
registration and consent-based OAuth can be added only when authorization-code, PKCE, resource
audience, revocation, and grant persistence are implemented together.

## Production

### Build and start

```bash
bun run build
MEKKA_STUDIO_ACCESS_TOKEN="replace-with-a-random-token" \
SQLITE_META_DATA_DIRECTORY="/absolute/path/to/mekka-data" \
bun run --cwd apps/studio start:production
```

The production launcher starts the built SQLite metadata runtime and Studio, derives an internal
proxy credential, forwards shutdown signals, and terminates the stack if either child exits.

### Docker

Build from the repository root so workspace dependencies are available:

```bash
docker build \
  --build-arg NEXT_PUBLIC_SITE_URL=https://mekka.example.com \
  --build-arg NEXT_PUBLIC_MEKKA_GATEWAY_URL=https://mekka.example.com \
  -f apps/studio/Dockerfile \
  -t mekka-studio .
```

Run with persistent data and server-only secrets:

```bash
docker run --rm \
  -p 3000:3000 \
  -v mekka-data:/data \
  -e MEKKA_PUBLIC_URL=https://mekka.example.com \
  -e MEKKA_STUDIO_ACCESS_TOKEN=replace-with-at-least-24-random-characters \
  -e MEKKA_AUTH_SESSION_SECRET=replace-with-at-least-32-random-characters \
  -e MEKKA_RESEND_API_KEY=re_replace_me \
  -e 'MEKKA_AUTH_EMAIL_FROM=Mekka <auth@example.com>' \
  mekka-studio
```

Terminate TLS at a trusted reverse proxy and forward the original public origin. Persist `/data`,
back it up, and test restores before handling valuable data.

### Health endpoints

| Endpoint | Meaning |
| --- | --- |
| `/api/health/live` | Studio process is alive. |
| `/api/health/ready` | Studio and required backend dependencies are ready. |
| `/.well-known/oauth-protected-resource/mcp` | MCP protected-resource metadata. |

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start local Studio and SQLite backend. |
| `bun run format` | Format non-generated repository files. |
| `bun run format:check` | Verify formatting without changing files. |
| `bun run lint` | Run Biome lint checks. |
| `bun run lint:studio` | Run Studio ESLint checks. |
| `bun run typecheck` | Typecheck core TypeScript project references. |
| `bun run typecheck:studio` | Typecheck the Studio application. |
| `bun run test` | Run the core test suite. |
| `bun run test:studio:fork` | Run Mekka Studio integration assertions. |
| `bun run build` | Build core packages and production Studio. |
| `bun run smoke:studio:production` | Boot and probe the production Studio stack. |
| `bun run check` | Run the complete release gate. |

## Repository Map

```text
apps/
  gateway/             REST, Storage, Realtime, Supabase compatibility, MCP mounting
  health-service/      Minimal independent health-service example
  mcp/                 MCP resources, tools, HTTP transport, capability enforcement
  sqlite-meta/         Local project data, schema management, Auth, MCP runtime
  studio/              React control surface and production server

packages/
  auth-core/           Project Auth, JWT/JWKS, OAuth and admin operations
  branch-core/         Preview branches and promotion invariants
  migration-engine/    Migration planning, application and schema checks
  onboarding-core/     Project connection analysis and onboarding contracts
  policy-engine/       Row and field policy simulation and AST rewriting
  protocol/            Tenant identity, capabilities, correlation IDs, errors
  query-ast/           Validated query and mutation representation
  realtime-core/       Changefeed, subscriptions, channels and presence
  schema-manifest/     Stable schema metadata contracts
  sqlite-compiler/     Prepared SQLite statement compiler
  storage-core/        SQLite adapter, objects, providers, signed reads, uploads
  studio-domain-sdk/   Typed Studio-to-backend boundary
  testkit/             Shared deterministic test helpers
  ui/                  UI primitives
  ui-patterns/         Composed interface patterns

docs/
  engine-capabilities/ Public engine behavior and limitations
  runbooks/            Backup, restore, key compromise and upstream operations
```

## Security Model

- Authentication happens before authorization.
- Tenant identity includes organization, project, environment, branch, and generation.
- Capabilities are action-scoped, tenant-bound, and time-bounded.
- SQL values use prepared parameters; identifiers resolve through schema metadata.
- Cross-tenant project resolution is checked again after storage lookup.
- MCP logs and resources exclude raw tokens, SQL text, secrets, and untrusted message bodies.
- Destructive schema operations create checkpoints.
- Production data directories must be absolute and backend listeners remain loopback-only.
- Local verification codes are unavailable in production.

This repository is under active development. Passing tests are not a substitute for deployment
hardening, threat modeling, backups, monitoring, or an independent security review. Report
vulnerabilities privately through [`SECURITY.md`](SECURITY.md).

## Compatibility

Mekka implements selected Supabase-compatible behavior so existing clients can be adopted in
bounded scenarios. Compatibility is tested, not assumed. Unsupported semantics return explicit
errors instead of silently behaving differently. See:

- [`apps/gateway/COMPATIBILITY.md`](apps/gateway/COMPATIBILITY.md)
- [`apps/gateway/SUPABASE_DATA_COMPATIBILITY.md`](apps/gateway/SUPABASE_DATA_COMPATIBILITY.md)
- [`apps/studio/UPSTREAM.md`](apps/studio/UPSTREAM.md)

Mekka Studio includes code derived from Supabase Studio under the upstream Apache License 2.0.
Upstream provenance and the reproduced license are kept in `apps/studio/UPSTREAM.md` and
`apps/studio/UPSTREAM_LICENSE`.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md), keep changes focused, include negative-path tests, and
run `bun run check` before opening a pull request. Never include credentials, private prompts,
customer data, local databases, or production logs in an issue or commit.

## License

Mekka is source-available under the **Mekka Business License 2.0**. Small organizations may embed
and use Mekka in their own products under the Additional Use Grant. Selling Mekka, offering it as
a hosted service, creating a competing backend platform, or building a business whose primary
commercial value is Mekka requires a separate commercial agreement.

This is not an OSI-approved open-source license. See [`LICENSE.md`](LICENSE.md) for the controlling
terms. Third-party components remain under their respective licenses.
