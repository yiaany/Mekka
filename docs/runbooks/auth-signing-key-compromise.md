# Auth signing-key compromise

This runbook applies when a project JWT private signing key may have been exposed. Normal scheduled rotation keeps the old public key in JWKS until every access token it signed has expired; compromise handling does not.

## Containment

1. Disable token issuance for the affected full tenant tuple: organization, project, environment, branch, and generation.
2. Mark the compromised `kid` revoked in the authoritative control-plane key registry and remove it from the JWKS key set immediately. Do not retain rotation overlap for a compromised key.
3. Generate a new ES256 key pair inside KMS or the approved secret store. The private key must never enter the project database, repository, logs, browser, or incident ticket.
4. Publish the new public JWK and restart or reload every auth issuer for the affected tuple before re-enabling issuance.
5. Revoke all Better Auth sessions and refresh-token chains for the affected project. Require users and service actors to authenticate again.

## Verification

1. Confirm `GET /.well-known/jwks.json` contains the new `kid`, omits the compromised `kid`, and contains no private `d` parameter.
2. Confirm a token signed by the compromised key is rejected even if its `exp` is still in the future.
3. Confirm a new token is accepted only for the exact issuer, audience, tenant tuple, and generation.
4. Check gateway and CDN JWKS caches. Purge stale entries or wait only if the issuer remains disabled; never re-enable while a verifier can still accept the compromised key.
5. Review auth, secret-store, deployment, and administrative audit events to establish exposure time and affected tenants. Do not place raw tokens, OAuth credentials, private keys, or user PII in the incident record.

## Recovery

1. Re-enable issuance after all verifiers use the new key set and stale caches are cleared.
2. Notify affected customers according to the incident policy and document whether provider credentials, session secrets, or only the JWT key were exposed.
3. Rotate OAuth client secrets and the Better Auth session secret too if their confidentiality cannot be independently established.
4. Add a regression or operational control for the root cause before closing the incident.
