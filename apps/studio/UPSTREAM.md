# Supabase Studio upstream provenance

Mekka Studio is a private derivative of Supabase Studio.

## Pinned source

- Repository: `https://github.com/supabase/supabase`
- Tag: `self-hosted/v0.7.1`
- Commit: `9e225a279b33e4e6e1452e573a40a6a25aa2cb2f`
- License: Apache License 2.0, reproduced in `UPSTREAM_LICENSE`
- Upstream `NOTICE` file: none present at the pinned commit
- Verified: 5 August 2026

## Imported paths

- `apps/studio`
- `packages/ai-commands`
- `packages/api-types`
- `packages/build-icons`
- `packages/common`
- `packages/config`
- `packages/dev-tools`
- `packages/eslint-config-supabase`
- `packages/icons`
- `packages/pg-meta`
- `packages/shared-data`
- `packages/tsconfig`
- `packages/ui`
- `packages/ui-patterns`

Only the workspace dependency closure required to build Studio was imported. Upstream environment files, secrets, deployment state, caches, and unrelated monorepo applications were not imported.

## Mekka changes

The derivative is forced into local self-hosted mode, uses Mekka branding, disables analytics and error-reporting exports, removes Supabase Cloud bootstrap endpoints, and hides features that are not supported by the current Mekka backend. Package names and protocol-level Supabase identifiers may remain where they are required for source compatibility; they do not imply endorsement or hosted-service coupling.

The Auth management slice retains the pinned Auth navigation/layout, form primitives and confirmation dialog patterns. GoTrue/platform data clients were replaced with the Mekka Studio Domain SDK and a constrained same-origin proxy. Only users/session revocation, Google/GitHub providers, exact redirect URLs and verification/reset templates are enabled; MFA, SSO, OAuth server/apps, hooks, SMTP, rate limits and PostgreSQL policy links remain hidden.

The Storage slice retains the pinned Storage layouts, navigation, visual primitives and bucket/file workflow concepts. Supabase service-role clients, temporary project API keys, PostgreSQL `storage.objects` RLS editors and direct provider endpoints were replaced by the Mekka Studio Domain SDK and a constrained same-origin proxy. Bucket lifecycle, object list/upload/signed-download/delete, resumable progress/retry and read-only effective policy summaries are enabled. Move/rename, transforms, advanced CDN/S3 controls, public delivery and policy editing remain hidden or explicitly unsupported.

See `docs/runbooks/studio-upstream-update.md` for the update procedure.
