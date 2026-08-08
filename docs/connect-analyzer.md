# Connect Analyzer

## Purpose

`analyzeConnectRepository` builds a deterministic, typed integration plan for a repository that has already been placed in a trusted, isolated sandbox. The analyzer is read-only: it never executes repository code, package scripts, hooks, build commands, or network configuration.

## Authorization and isolation

- The caller passes a validated `TenantContext` with the tenant-bound `connect:analyze` capability.
- The caller passes `sandboxRoot` and an optional relative `repositoryPath`; absolute paths and `..` traversal segments are rejected.
- Both sandbox and repository are canonicalized before scanning. A resolved repository outside the sandbox is denied.
- The scanner reads only regular files, never follows symlinks, ignores dependency/build directories, and returns relative paths only.
- The default limits are 2,000 scanned directory entries, 512 KiB per file, 2 MiB total input, and 2 seconds. Limit exhaustion fails closed with `quota`.

## Detection

- Framework: Next.js and Vite/React from parsed `package.json` dependencies.
- Package manager: Bun, pnpm, Yarn, npm lockfiles.
- Monorepo: selects the lexicographically first supported application manifest deterministically.
- Existing clients: Supabase and Litebase SDK dependencies become review/merge proposals, never overwrites.
- Environment: reads variable names from `.env*`; values are never returned. Secret-like values become a redacted conflict marker.

## Generated plan

The plan proposes SDK package action, typed client module path, client-safe environment variable names, `.mcp.json` action with secrets forbidden, schema-manifest inspection, and smoke checks. It contains no mutation, patch content, access token, environment value, provider credential, or database secret.

Applying a plan, writing files, deployment provider configuration, and GitHub access are separate approval-controlled features.
