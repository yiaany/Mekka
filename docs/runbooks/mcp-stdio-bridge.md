# MCP stdio bridge runbook

The public `mekka` package includes `bin/mcp-stdio.js`. It transparently forwards MCP JSON-RPC
messages between the official SDK's `StdioServerTransport` and `StreamableHTTPClientTransport`.

## Security properties

- Bearer tokens are read from `MEKKA_MCP_TOKEN` or the environment variable named by `--token-env`.
- Plaintext `--token` arguments and URLs with credentials, queries, or fragments are rejected.
- Transport failures emit a fixed stderr message so SDK or fetch errors cannot disclose headers.
- Remote endpoints require HTTPS. Loopback HTTP is accepted for development and integration tests.

## Verification

Run `bun run cli:test` for parser tests and the process-level bridge test. The process test starts an
official SDK Streamable HTTP server, launches `node bin/mekka.js mcp-stdio`, and uses the official SDK
stdio client to list and invoke a tool through the bridge.

Run `npm pack --dry-run ./packages/mekka-cli` to verify that both launcher files are included.
