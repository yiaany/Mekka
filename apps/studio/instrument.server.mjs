// Server-side Sentry init for the TanStack Start runtime.
//
// Mirrors sentry.server.config.ts (the Next.js server init) but uses the
// unified `@sentry/tanstackstart-react` SDK. Loaded:
//   - self-hosted / e2e (scripts/serve.js): dynamically imported AFTER the
//     .env files are read into process.env, so the DSN is available.
//   - Vercel (api/server.js): imported at module top (gated to TanStack),
//     Vercel injects env vars into process.env for us.
//
// Reads process.env at call time (unlike NEXT_PUBLIC_* which the client bundle
// inlines at build time), so it must run after env loading on self-hosted.

// Server error reporting is intentionally disabled in the private fork.
