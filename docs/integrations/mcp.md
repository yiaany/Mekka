# MCP client integration

Mekka exposes an MCP endpoint using the official Streamable HTTP transport.

## Claude Code

Claude Code supports the endpoint directly:

```sh
claude mcp add --transport http --scope local mekka http://127.0.0.1:8082/mcp --header "Authorization: Bearer <token>"
```

## OpenCode

Current OpenCode releases support Streamable HTTP remote servers. Put the token in an environment
variable rather than committing it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mekka": {
      "type": "remote",
      "url": "http://127.0.0.1:8082/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:MEKKA_MCP_TOKEN}"
      }
    }
  }
}
```

Older OpenCode builds that report `expected text/event-stream` are using an SSE-only remote
transport. Configure the stdio bridge below instead of changing Mekka's Streamable HTTP endpoint.

## Zed

Zed supports remote MCP servers with custom headers:

```json
{
  "context_servers": {
    "mekka": {
      "url": "http://127.0.0.1:8082/mcp",
      "headers": {
        "Authorization": "Bearer <temporary-token>"
      }
    }
  }
}
```

## Codex

Codex supports Streamable HTTP and resolves bearer tokens from the active process environment:

```toml
[mcp_servers.mekka]
url = "http://127.0.0.1:8082/mcp"
bearer_token_env_var = "MEKKA_MCP_TOKEN"
```

Restart the Codex process after setting `MEKKA_MCP_TOKEN` so the temporary token is visible to it.

## Aider

Aider's current official configuration does not expose MCP servers. Mekka does not claim native Aider
integration until Aider ships an MCP client interface. Use a supported MCP-capable coding agent for
Mekka tools while continuing to use Aider for repository edits.

## Stdio bridge

Use the published `mekka` CLI when a client supports MCP over stdio but not Streamable HTTP:

```sh
MEKKA_MCP_TOKEN=your-token npx mekka mcp-stdio --url https://your-mekka-host.example/mcp
```

A client configuration should launch `npx` with these arguments:

```json
{
  "command": "npx",
  "args": [
    "mekka",
    "mcp-stdio",
    "--url",
    "https://your-mekka-host.example/mcp",
    "--token-env",
    "MEKKA_MCP_TOKEN"
  ],
  "env": {
    "MEKKA_MCP_TOKEN": "<token supplied by your secret manager>"
  }
}
```

Do not place the token in `args` or in the endpoint URL. The bridge intentionally has no `--token`
option and rejects endpoint query parameters. Use a client secret store or inherited environment
variable where the client supports one.

The bridge is also the compatibility path for any MCP client that can launch a local stdio server but
cannot connect to Streamable HTTP directly.
