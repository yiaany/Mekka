# Studio upstream update

## Purpose

Update the private Studio fork while preserving its local-only security and product boundaries.

## Procedure

1. Clone upstream into an approved temporary directory with `git clone --filter=blob:none https://github.com/supabase/supabase`.
2. Select a stable self-hosted tag, record its exact commit, and verify that the root license is Apache-2.0. Check whether the selected commit adds a `NOTICE` file.
3. Compare `apps/studio` and the imported package paths listed in `apps/studio/UPSTREAM.md`. Do not copy the full upstream monorepo.
4. Import source changes only. Do not import `.env` files, secrets, certificates/private keys, `.vercel`, deployment identifiers, build caches, generated artifacts, or unrelated applications.
5. Reapply and review Mekka fork points before installation:
   - `apps/studio/lib/fork-config.ts`
   - `apps/studio/lib/constants/index.ts`
   - `packages/common/constants/environment.ts`
   - `apps/studio/lib/telemetry.tsx` and `apps/studio/lib/telemetry/track.ts`
   - `apps/studio/instrumentation.ts`, `instrumentation-client.ts`, and Sentry config files
   - `apps/studio/next.config.ts`, `security-headers.ts`, `vercel.ts`, and `csp.ts`
   - navigation and command-menu feature gating
   - metadata, manifests, logos, hosted links, and local endpoint defaults
6. Update `apps/studio/UPSTREAM.md` with the new tag, commit, verification date, package closure, and any license/NOTICE changes.
7. Run `bun install --ignore-scripts`, then `bun run test:studio:fork`, `bun run typecheck:studio`, `bun run lint:studio`, and `bun run build:studio`.
8. Start the production build with `bun run start:studio` and verify a local HTTP response without outbound Supabase Cloud, analytics, or Sentry requests.
9. Scan runtime source for visible upstream branding, hosted endpoints, analytics hosts, deployment IDs, private keys, and imported secrets. Review every match rather than deleting compatibility identifiers blindly.

## Required invariants

- `IS_PLATFORM` remains hard-coded to `false` in Studio and `common`.
- Table Editor and SQL Editor are the only enabled Studio product areas until a later session explicitly expands support.
- Telemetry, session replay, Sentry, PostHog, GTM, and hosted status checks remain disabled.
- No environment variable may enable Supabase platform redirects, CSP, asset hosting, or Cloud API bootstrap.
- `PG_META_CRYPTO_KEY`, `POSTGRES_PASSWORD`, and `AUTH_JWT_SECRET` remain required runtime secrets with no checked-in or well-known fallback values.
- Apache-2.0 provenance remains distributed with the derivative.
