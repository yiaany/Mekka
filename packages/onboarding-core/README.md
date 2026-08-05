# Onboarding core

`@mekka/onboarding-core` owns the control-plane state machine for Studio Quick Setup.

The caller supplies durable `OnboardingRepository` and provider-specific `OnboardingProvisioner` implementations. A project becomes `ready` only after provisioning and its first health check succeed. Any failure runs cleanup before the failed record is stored without connection details, so the incomplete resource is never published as routable.

The HTTP adapter exposes `POST /onboarding` and `POST /onboarding/:id/retry`. Both require an `Idempotency-Key`; the retry path is actor-bound and accepts only previously failed records.
