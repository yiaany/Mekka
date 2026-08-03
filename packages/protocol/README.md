# Protocol

`@mekka/protocol` defines stable, transport-neutral contracts shared by control-plane and data-plane services.

## Tenant Identity

Every resource access is scoped by a complete immutable tuple:

```text
organization_id / project_id / environment_id / branch_id / generation
```

Identifiers are opaque lowercase strings matching `[a-z][a-z0-9_-]{2,63}`. `generation` is a positive safe integer and changes when a logical resource is recreated. Callers must parse external input with `parseTenantIdentity` or `parseTenantIdentityFromHeaders`; no partial tuple is representable after parsing.

`createTenantCacheKey` accepts a full `TenantIdentity` and always includes `generation`, preventing a cache entry for a deleted resource from being used by a recreated resource.

## HTTP Boundary

HTTP adapters must use these headers before routing or authorization:

| Tuple member | Header |
| --- | --- |
| organization | `x-mekka-organization-id` |
| project | `x-mekka-project-id` |
| environment | `x-mekka-environment-id` |
| branch | `x-mekka-branch-id` |
| generation | `x-mekka-generation` |

`x-correlation-id` accepts an RFC 4122 UUID. `resolveCorrelationId` preserves a valid incoming ID and generates a new one for a missing or malformed value. Authentication is deliberately external to this package: after token verification, pass the verified actor and capabilities to `createTenantContextFromHeaders`.

Capabilities must have the same full tenant tuple as the request context. A mismatch fails closed with `forbidden`; this package does not verify JWT signatures or database authorization.

## Public Errors

`toErrorResponse` emits only this stable envelope:

```json
{
  "error": {
    "code": "validation",
    "message": "Request validation failed.",
    "correlationId": "018f2a11-2c8d-7cb4-9d46-1f1297e55cb8"
  }
}
```

The contract distinguishes `validation` (400), `auth` (401), `forbidden` (403), `conflict` (409), `quota` (429), `unsupported` (501), and `infrastructure` (503). Unexpected errors are always converted to the generic infrastructure response, so stack traces and exception text cannot enter the public payload.
