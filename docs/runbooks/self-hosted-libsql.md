# Self-hosted libSQL

This profile runs one writable libSQL primary behind Caddy HTTPS. It does not require Turso Cloud and does not provide Turso preview databases.

## Prerequisites

- A Linux VPS with Docker Compose, SSD-backed persistent storage, and inbound TCP 80/443.
- DNS `A`/`AAAA` records for the libSQL hostname pointing to the VPS.
- Separate encrypted off-host backup storage.

## Authentication

Generate an Ed25519 PKCS#8 key pair outside the repository. Keep the private key offline or in the system that signs client JWTs. Place only the public key at `deploy/libsql/secrets/libsql-jwt-public.pem` on the VPS. The server reads it through `SQLD_AUTH_JWT_KEY_FILE`.

Issue a bounded client JWT signed by that private key and provide it only to Mekka:

```dotenv
MEKKA_DATA_ENGINE=libsql-remote
MEKKA_LIBSQL_URL=https://libsql.example.com
MEKKA_LIBSQL_TOKEN_ENV=MEKKA_LIBSQL_TOKEN
MEKKA_LIBSQL_TOKEN=<signed-client-jwt>
```

Do not put either private keys or JWTs in Compose, Git, browser variables, URLs, logs, or support bundles.

The JWT must use `alg=EdDSA`, include a short `exp` Unix timestamp, and explicitly scope write access to the default namespace:

```json
{"p":{"rw":{"ns":["default"]}},"exp":<unix-seconds>}
```

Never omit the `p` claim: sqld's legacy fallback can otherwise grant broader write access than intended.

## Start And Update

1. Copy `deploy/libsql/.env.example` to a deployment-only `.env` and set DNS/email values.
2. Install the public JWT key in `deploy/libsql/secrets/` with owner-only write permissions.
3. Validate with `docker compose -f deploy/libsql/compose.yaml config`.
4. Start with `docker compose -f deploy/libsql/compose.yaml up -d`.
5. Verify HTTPS, an unauthorized request rejection, an authenticated query, and `MEKKA_DATA_ENGINE=libsql-remote` connection status.

Before deploying, run `bun run smoke:libsql`. It creates disposable authenticated containers and verifies CRUD, rollback, invalid and expired credentials, restart persistence, backup, and restore into a separate volume.

Updates must pin and review a new image digest. Stop writes, take an off-host backup, pull the reviewed image, recreate the service, and run the authenticated CRUD/rollback smoke before reopening traffic.

## Graceful Shutdown

Stop the Mekka writers first. Then run `docker compose -f deploy/libsql/compose.yaml stop -t 30 libsql`. Do not copy live database files while the process is writing.

## Backup And Restore

This baseline uses a shutdown-consistent volume backup because the pinned image is not configured for provider-managed PITR.

1. Quiesce Mekka writes and stop libSQL gracefully.
2. Snapshot or archive the `libsql-data` volume with the VPS/storage provider.
3. Encrypt and transfer the backup outside the VPS.
4. Restart libSQL and run an authenticated read smoke.
5. Regularly restore into a new temporary volume and isolated Compose project.
6. Start the restored server without public DNS, connect read-only, and verify schema plus representative row counts.
7. Delete the temporary restore only after recording the verification result.

Never restore over the active volume. This runbook does not claim point-in-time recovery.

## Rollback

Keep the previous reviewed image digest and latest verified off-host backup. Stop writers, recreate with the previous digest, and verify the existing volume. If storage migration made that unsafe, restore the backup into a new volume and switch only after the read smoke passes.

## Limits

- One writable primary on one VPS is a single point of failure.
- libSQL retains SQLite's single-writer constraints.
- Backups must live outside the VPS and restore drills remain an operator responsibility.
- Turso Cloud preview lifecycle is unsupported in this self-hosted profile.
- Local SQLite remains for development, isolated tests, Auth, approvals, and other documented control-plane metadata.
- Until SQLite Meta's synchronous storage contract is replaced, table/row/schema/MCP production data paths are not allowed to claim remote libSQL operation solely because `/engine/test-connection` succeeds.
