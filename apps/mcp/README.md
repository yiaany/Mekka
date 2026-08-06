# Mekka MCP

`@mekka/mcp` exposes read-only resources and controlled preview mutations for one authenticated tenant branch.

## Supported surfaces

- Resources: `schema://current`, `schema://branch/{branchId}`, `policies://current`, `migrations://history`, `logs://recent`, `capabilities://session`.
- Read tools: `inspect_schema`, `explain_query`, `list_migrations`, `get_policy_summary`.
- Mutation tools: `create_preview_branch`, `propose_migration`, `apply_to_preview`, `validate_changes`, `request_promotion`.
- Local mode: call `startMcpStdio(context, dependencies)` after the local runtime has already authenticated and created a tenant-bound context.
- Remote mode: route requests to `createMcpHttpResponse(request, dependencies)`. The MCP endpoint is stateless Streamable HTTP and supports JSON responses.

## Remote configuration

`protectedResource.resourceUrl` must be the exact public MCP URL, for example `https://mcp.example.com/mcp`. `authorizationServerUrl` must be the exact HTTPS OAuth authorization-server URL. The endpoint publishes OAuth protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`.

The authorization server owns PKCE and token issuance. Its verifier must validate the token signature, expiration, issuer, exact audience for the MCP resource, and the complete tenant tuple before it returns `VerifiedAuthAccessToken`. `McpCapabilityStore` must return only tenant-bound capabilities for the verified actor.

## Security boundaries

- The endpoint requires `mcp:read`; expired capabilities are denied for server creation and every resource/tool read.
- HTTP accepts only a bearer token. Raw tokens are not put into resources, logs, capability data, or tool arguments.
- Resource and project tenant tuples must match exactly, including `generation`; unresolved or mismatched projects are denied.
- `explain_query` parses the constrained query dialect and returns a compiler SQL template only. It does not execute SQL or return bound values.
- Migration history omits SQL text. Logs omit message text and attributes and are marked as untrusted prompt input.
- This version provides no direct production write tool, arbitrary SQL execution, row-data access, credential access, or token passthrough.

## Preview mutation workflow

- `create_preview_branch` requires `mcp:preview:create` on the authenticated parent tenant and creates only a short-lived child branch through `@mekka/branch-core`.
- `propose_migration`, `apply_to_preview`, and `validate_changes` require separate branch-bound action scopes. A proposal records a validated migration artifact, returns plan metadata only, and never includes DDL text in its result.
- `request_promotion` creates a Studio approval request bound to the complete preview tenant tuple, proposal ID, artifact hash, parent schema hash, and validated preview schema hash.
- An approved request alone cannot mutate production. The same request needs unexpired `mcp:promotion:execute`; `branch-core` then performs the production schema CAS and replay-safe promotion.
- The local mutation catalog records preview/proposal state and a durable audit ledger. External Studio/audit delivery is best-effort and cannot remove committed state or grant a capability.
- Mutation retries reuse the persisted branch/proposal/promotion state. Reusing an idempotency key for a different actor or tenant is denied.

`McpStudioApprovalHook` is the Studio control-plane boundary. It must store decisions durably and return only bound, short-lived decisions; prompt text, tool results, logs, and resources never create or elevate capabilities.

## Dependency injection

The host supplies project resolution, sanitized-log retrieval, access-token verification, and capability lookup. These are explicit boundaries because project routing, control-plane capability persistence, OAuth flows, and audit persistence are owned by their corresponding services.
