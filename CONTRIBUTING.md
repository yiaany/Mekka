# Contributing to Mekka

## Before You Start

- Read the public architecture, capability documentation, and relevant runbooks.
- Keep one pull request focused on one complete vertical slice.
- Do not add placeholder packages, speculative abstractions, or unrelated refactors.
- Never commit credentials, `.env` files, generated output, or production data.

## Local Verification

Use Bun `1.3.14` and run the same gate as CI before opening a pull request:

```sh
bun install --frozen-lockfile
bun run check
```

## Commit Messages

Write an imperative Conventional Commit subject that names the delivered change. A reader should
understand what the commit introduced without opening the diff.

Good examples:

```text
feat(auth): add email verification token rotation
fix(router): reject requests with stale tenant generations
docs(studio): document the SQLite table editor limitations
test(policy): cover cross-tenant update denial
chore(ci): run the repository verification gate on pull requests
```

Avoid vague or repeated messages such as `update files`, `changes`, `fix`, or `wip`.

## Pull Requests

- Explain the user-visible behavior and security boundaries.
- Include focused tests for success and negative cases.
- State exact verification commands and results.
- Update contracts and documentation when public behavior changes.
- Do not commit private prompts, agent transcripts, local databases, or production logs.

## Design Principles

- Tenant identity is always the complete tuple: organization, project, environment, branch, and
  generation.
- Authentication precedes authorization; uncertainty must fail closed.
- User values never become interpolated SQL; identifiers must resolve through schema metadata.
- Unsupported Supabase behavior returns an explicit error instead of a silent semantic change.
