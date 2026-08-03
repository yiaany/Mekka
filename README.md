# Mekka

[![CI](https://github.com/yiaany/mekka/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yiaany/mekka/actions/workflows/ci.yml)

**Mekka is building a lightweight, agent-safe backend platform for applications that need the
developer experience of a modern BaaS without treating every project as a dedicated PostgreSQL
cluster.**

The product is designed around one resource model for three entry points:

- **Connect Project**: connect an existing application through a reviewed, reversible diff.
- **Studio**: configure a backend manually with safe defaults and full advanced controls.
- **MCP**: give AI agents the same domain operations with narrow capabilities, previews,
  approvals, and audit trails.

> **Project status:** pre-alpha. The repository currently provides the engineering foundation:
> strict Bun/TypeScript workspaces, shared protocol types, test utilities, CI, and a health
> service. Database, Auth, Storage, Realtime, Functions, and Studio are planned, not shipped.

## Why Mekka

AI-assisted development creates more small applications, temporary environments, and database
branches than traditional backend platforms were built to operate. Mekka targets this model with
SQLite-compatible storage, explicit tenant identity, and a safe change lifecycle instead of
handing agents an unrestricted production SQL token.

Every request and authorization decision is scoped by:

```text
organization_id / project_id / environment_id / branch_id / generation
```

When routing or authorization is uncertain, the system is designed to deny by default.

## Architecture Direction

```text
Client / Studio / MCP
         |
         v
Auth + Rate Limits + Capability Verification
         |
         v
Typed Query AST -> Policy Rewriter -> SQL Compiler
         |
         v
StorageAdapter -> SQLite-compatible data plane
```

The long-term control plane owns organizations, projects, environments, routing, billing,
capabilities, secrets metadata, and audit indexes. The data plane executes application requests,
enforces policies, compiles typed queries, and reports project-level telemetry.

Read the full product and technical strategy in
[`LITEBASE_YC_STRATEGY_RU.md`](./LITEBASE_YC_STRATEGY_RU.md). The working document is in Russian.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) `1.3.14`

### Install and verify

```sh
bun install --frozen-lockfile
bun run check
```

### Run the health service

```sh
bun run start:health
```

The endpoint is available at `http://127.0.0.1:3000/health`.

`HOST` defaults to `127.0.0.1` and `PORT` defaults to `3000`. Invalid port values stop startup
with an explicit error rather than choosing an implicit fallback.

## Development Commands

| Command | Purpose |
| --- | --- |
| `bun run format` | Format the repository with Biome. |
| `bun run lint` | Run static lint checks. |
| `bun run typecheck` | Run strict TypeScript project checks. |
| `bun run test` | Run the current unit-test suite. |
| `bun run build` | Build TypeScript project references. |
| `bun run smoke:health` | Bind the health service, call `/health`, and stop it. |
| `bun run check` | Run the complete local verification gate. |

## Repository Layout

```text
apps/
  health-service/     Minimal Elysia service and startup smoke test
packages/
  protocol/           Stable shared contracts and error categories
  testkit/            Small shared test helpers
docs/
  session-logs/       Russian implementation records for completed sessions
session-prompts/      Ordered vertical-slice delivery backlog
```

## Delivery Model

Development proceeds as small, complete vertical slices. Each session has one feature, explicit
security boundaries, executable acceptance checks, and a Russian implementation log under
`docs/session-logs/`.

The current sequenced roadmap starts with tenant identity, storage abstractions, query parsing,
schema manifests, policies, REST data operations, and migrations. Product scope and technical
invariants are documented in the strategy and session prompts rather than implied by placeholders
in code.

## Security

Mekka follows deny-by-default authorization, tenant-scoped routing, prepared statements,
identifier allowlists, capability-limited MCP operations, and auditability for privileged actions.
Please report vulnerabilities privately; see [`SECURITY.md`](./SECURITY.md).

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request. It defines the local
verification gate, commit format, and expectations for session logs.

## License

Mekka is currently proprietary software. See [`LICENSE.md`](./LICENSE.md).
