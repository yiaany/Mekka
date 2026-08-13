import process from "node:process";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const defaultTokenEnvironmentVariable = "MEKKA_MCP_TOKEN";
const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bearerTokenPattern = /^[A-Za-z0-9._~-]+$/;

export function parseMcpStdioArguments(args) {
  const options = {
    url: null,
    tokenEnvironmentVariable: defaultTokenEnvironmentVariable,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--url") options.url = requireOptionValue(args, ++index, "--url");
    else if (argument === "--token-env") {
      options.tokenEnvironmentVariable = requireOptionValue(args, ++index, "--token-env");
    } else if (argument === "--token" || argument.startsWith("--token=")) {
      throw new Error("Plaintext MCP tokens are not accepted in arguments; use --token-env.");
    } else {
      throw new Error(`Unknown mcp-stdio option: ${argument}`);
    }
  }

  if (options.help) return options;
  if (!options.url) throw new Error("mcp-stdio requires --url.");
  if (!environmentVariablePattern.test(options.tokenEnvironmentVariable)) {
    throw new Error("--token-env must be a valid environment variable name.");
  }
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The MCP URL must not contain credentials, a query, or a fragment.");
  }
  if (url.protocol !== "https:" && !isLoopbackHttpUrl(url)) {
    throw new Error("The MCP URL must use HTTPS, except for loopback development endpoints.");
  }
  options.url = url.href;
  return options;
}

export async function runMcpStdioBridge(
  args,
  {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
  } = {},
) {
  const options = parseMcpStdioArguments(args);
  if (options.help) {
    stdout.write(`Mekka MCP stdio bridge

Usage:
  npx mekka mcp-stdio --url <https-url> [--token-env <name>]

Options:
  --url <url>         Upstream Streamable HTTP MCP endpoint
  --token-env <name>  Environment variable containing the bearer token
                      (default: ${defaultTokenEnvironmentVariable})
  -h, --help          Show this help
`);
    return;
  }

  const token = env[options.tokenEnvironmentVariable];
  if (!token) {
    throw new Error(
      `MCP bearer token environment variable is not set: ${options.tokenEnvironmentVariable}`,
    );
  }
  if (!bearerTokenPattern.test(token)) {
    throw new Error("The MCP bearer token environment variable is malformed.");
  }

  const upstream = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const downstream = new StdioServerTransport(stdin, stdout, { maxBufferSize: 1_000_000 });
  const initializeRequestIds = new Set();
  let upstreamWrites = Promise.resolve();
  let downstreamWrites = Promise.resolve();
  let closing = false;

  const fail = (error) => {
    if (closing) return;
    closing = true;
    stderr.write(`${mcpStdioTransportFailureMessage(error, options.tokenEnvironmentVariable)}\n`);
    Promise.allSettled([upstream.close(), downstream.close()]).finally(() => {
      process.exitCode = 1;
    });
  };

  downstream.onmessage = (message) => {
    if ("method" in message && message.method === "initialize" && "id" in message) {
      initializeRequestIds.add(message.id);
    }
    upstreamWrites = upstreamWrites.then(() => upstream.send(message)).catch(fail);
  };
  upstream.onmessage = (message) => {
    if (
      "id" in message &&
      initializeRequestIds.delete(message.id) &&
      "result" in message &&
      typeof message.result === "object" &&
      message.result !== null &&
      "protocolVersion" in message.result &&
      typeof message.result.protocolVersion === "string"
    ) {
      upstream.setProtocolVersion(message.result.protocolVersion);
    }
    downstreamWrites = downstreamWrites.then(() => downstream.send(message)).catch(fail);
  };
  upstream.onerror = fail;
  downstream.onerror = fail;
  stdin.once("end", () => {
    if (closing) return;
    closing = true;
    Promise.allSettled([upstream.close(), downstream.close()]);
  });

  try {
    await upstream.start();
    await downstream.start();
  } catch (error) {
    await Promise.allSettled([upstream.close(), downstream.close()]);
    throw new Error(mcpStdioTransportFailureMessage(error, options.tokenEnvironmentVariable));
  }
}

export function mcpStdioTransportFailureMessage(error, tokenEnvironmentVariable) {
  if (isHttpUnauthorized(error)) {
    return `MCP authentication failed (HTTP 401): ${tokenEnvironmentVariable} is invalid, expired, or replaced. Generate a new token and update the environment variable.`;
  }
  return "MCP stdio bridge could not connect to the upstream endpoint.";
}

function requireOptionValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return value;
}

function isLoopbackHttpUrl(url) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost")
  );
}

function isHttpUnauthorized(error) {
  if (typeof error !== "object" || error === null) return false;
  return error.code === 401 || error.status === 401 || error.statusCode === 401;
}
