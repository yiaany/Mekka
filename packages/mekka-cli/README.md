# Mekka CLI

Run Mekka with one command:

```sh
npx mekka
```

This installs or upgrades Bun automatically when necessary under `npx`, creates a `mekka` directory, installs every dependency,
builds the required workspace packages, and starts the complete local backend and Studio at
`http://127.0.0.1:8082`. Git is used for a shallow clone when available; otherwise the CLI securely
downloads and extracts the GitHub `main` branch archive over HTTPS.

The CLI currently follows `main` because the only repository release tag, `v0.1.0`, predates the
current launcher and cannot start this project correctly. Before the next CLI release is published,
the source ref in `bin/mekka.js` must be changed to that matching immutable release tag. The official
Bun installer URL intentionally remains mutable so it can install a supported Bun release.

Choose a different directory:

```sh
npx mekka my-app
```

Prepare the project without starting it:

```sh
npx mekka my-app --no-start
```

Clone the project source without installing, building, or starting it:

```sh
npx mekka my-app --no-install
```

The command prints the exact `bun install --frozen-lockfile && bun run dev` command to continue.

## MCP stdio bridge

Mekka's remote MCP endpoint uses Streamable HTTP. Clients with direct Streamable HTTP support should
connect to that endpoint directly and send the bearer token in the `Authorization` header.

For MCP clients that only launch stdio servers, use the official-SDK bridge included in this package:

```sh
MEKKA_MCP_TOKEN=your-token npx mekka mcp-stdio --url https://your-mekka-host.example/mcp
```

Set the token in the client process environment rather than command arguments. To use another
environment variable name:

```sh
npx mekka mcp-stdio --url https://your-mekka-host.example/mcp --token-env PROJECT_MCP_TOKEN
```

The bridge accepts HTTPS endpoints and loopback HTTP endpoints for local development. It does not
accept a `--token` argument, URL credentials, query parameters, or fragments.

For `npx mekka`, Node.js 20 or newer is the only prerequisite. Git is optional. If Bun is missing, the
CLI uses the official mutable platform installer, upgrades Bun versions older than 1.3.14, and locates the installed executable without requiring a
terminal restart. If automatic installation fails, it stops before downloading anything and prints
the exact manual installation command. `bunx mekka` inherently requires Bun.

Mekka is built in public under the Mekka Business License 2.0. The license gives qualifying small
organizations room to build while preventing third parties from repackaging Mekka as a competing
hosted backend or cloud service without a commercial agreement.
