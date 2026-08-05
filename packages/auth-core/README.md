# Auth core

`@mekka/auth-core` owns the server-only boundary for project Auth stores. Each store is a Better Auth SQLite database under a full tenant tuple and is physically separate from the application branch database.

`openProjectAuthService` receives session and OAuth credentials exclusively through `AuthSecretStore`, and ES256 key rings through `AuthSigningKeyStore`; it neither reads `process.env` nor accepts raw secrets. The public service exposes a Better Auth request handler, tenant-bound issuer/audience metadata, and strict access-token verification. It never exposes the SQLite database or private signing keys to the Data API.

Production and preview stores have different paths. Preview starts empty unless callers explicitly supply synthetic users. Synthetic users populate only Better Auth's `user` table and never create `account` credentials or `session` records.

Production enables email/password registration with verified-email login, a six-digit email OTP lifecycle, password reset, Google/GitHub OAuth, and a database-backed Better Auth rate limiter. OTP values are stored as hashes; `LocalAuthEmailSink` is available only for local development and integration tests. OAuth requires verified ownership of the issuer and every redirect origin, exact canonical HTTPS redirect URLs, PKCE/state, encrypted provider tokens, and explicit account linking with matching email.

`handleAdminRequest` exposes the Studio-only Auth administration boundary when `admin` options are configured. It requires a tenant-bound short-lived `auth:admin` capability; mutations additionally require an exact Studio origin, double-submit CSRF token, idempotency key, correlation ID, explicit user-id confirmation for revocation, and a durable audit sink. User responses contain bounded identity/session metadata. OAuth secrets are write-only to Studio clients through the read/write `AuthAdminSecretStore`; updates are batched and responses expose only configured booleans. Provider and exact redirect configuration is ownership-checked and applied by replacing the in-process Better Auth runtime before the mutation completes. Email template changes are read from the tenant store at send time and therefore apply immediately. Idempotency reservations remain pending after uncertain external failures so retries cannot duplicate secret, runtime, or audit side effects.

Email login returns a 15-minute ES256 project JWT plus a single-use refresh token. OAuth callback establishes only an HTTP-only Better Auth session; `POST /token` exchanges that server-side session for the same project JWT/refresh pair without exposing provider tokens. `POST /refresh` atomically rotates both the Better Auth session and HMAC-stored refresh token; reuse revokes every tenant-local session for the user. `GET /.well-known/jwks.json` publishes the current public key and only unexpired overlap keys. `verifyAccessToken` validates ES256, `kid`, issuer, audience, expiry, role, session ID, and the full tenant tuple.

## Upstream provenance

- Better Auth `v1.6.10`, commit `698678bcd08e0552661f9ae306b031674e588a2c`, MIT.
- The implementation uses the published Better Auth package and its SQLite migration/handler APIs. No upstream source code was copied into this package.
- `jose` `v6.2.3`, commit `41ad7e9a76d270ca7e24b7421a88e507f756f2db`, MIT.
- JWT/JWK/JWKS operations use published `jose` APIs. No JOSE primitive is implemented locally.
