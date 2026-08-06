# MCP TypeScript SDK provenance

- Repository: `https://github.com/modelcontextprotocol/typescript-sdk`
- Tag: `1.30.0`
- Commit: `2d889f2b329e46680ec9bdd565de4616c497825a`
- Commit date: 27 July 2026
- License: MIT, copyright 2024 Anthropic, PBC
- Local review clone: `C:\Users\ilyaa\AppData\Local\Temp\opencode\typescript-sdk-v1.30.0`

Reviewed scope:

- `src/server/mcp.ts` resource and tool registration contracts;
- `src/server/stdio.ts` local stdio transport and bounded input buffer;
- `src/server/webStandardStreamableHttp.ts` stateless Streamable HTTP transport;
- `src/server/auth/router.ts` protected-resource metadata, HTTPS, authorization-server and PKCE metadata contracts;
- SDK tool annotations and tool-result guidance relevant to non-read-only/destructive operations;
- SDK elicitation/authorization guidance: authorization is external to prompts and tool results, and no SDK result is treated as a capability grant;
- relevant Streamable HTTP and OAuth examples.

Mekka uses published `@modelcontextprotocol/sdk@1.30.0`. No upstream source, tests, LICENSE, or NOTICE files were copied or vendored into the product tree. This app owns its authorization, tenant-routing, capability and sanitization boundaries.
