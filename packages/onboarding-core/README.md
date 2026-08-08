# Onboarding core

`@mekka/onboarding-core` owns the control-plane state machine for Studio Quick Setup.

The caller supplies durable `OnboardingRepository` and provider-specific `OnboardingProvisioner` implementations. A project becomes `ready` only after provisioning and its first health check succeed. Any failure runs cleanup before the failed record is stored without connection details, so the incomplete resource is never published as routable.

The HTTP adapter exposes `POST /onboarding` and `POST /onboarding/:id/retry`. Both require an `Idempotency-Key`; the retry path is actor-bound and accepts only previously failed records.

## Connect Analyzer

`analyzeConnectRepository` is a read-only, capability-gated repository scanner for Connect Project. It requires the tenant-bound `connect:analyze` capability, receives a repository-relative path beneath a pre-created sandbox root, never executes repository code or package scripts, only reads regular files beneath a canonical root, rejects symlinks, and applies bounded file, byte, and duration limits. Its deterministic plan contains package, file, environment, MCP, migration-inspection and smoke-check proposals only; environment values and secrets are never returned.
