import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { parseMcpStdioArguments, runMcpStdioBridge } from "./mcp-stdio.js";

test("parses a secure environment-backed bridge configuration", () => {
  assert.deepEqual(
    parseMcpStdioArguments([
      "--url",
      "https://mcp.example.test/mcp",
      "--token-env",
      "PROJECT_MCP_TOKEN",
    ]),
    {
      url: "https://mcp.example.test/mcp",
      tokenEnvironmentVariable: "PROJECT_MCP_TOKEN",
      help: false,
    },
  );
});

test("rejects plaintext token arguments, credential URLs, and insecure remote HTTP", () => {
  assert.throws(
    () => parseMcpStdioArguments(["--url", "https://mcp.example.test/mcp", "--token", "secret"]),
    /Plaintext MCP tokens are not accepted/,
  );
  assert.throws(
    () => parseMcpStdioArguments(["--url", "https://token@mcp.example.test/mcp"]),
    /must not contain credentials, a query, or a fragment/,
  );
  assert.throws(
    () => parseMcpStdioArguments(["--url", "https://mcp.example.test/mcp?token=secret"]),
    /must not contain credentials, a query, or a fragment/,
  );
  assert.throws(
    () => parseMcpStdioArguments(["--url", "http://mcp.example.test/mcp"]),
    /must use HTTPS/,
  );
  assert.equal(
    parseMcpStdioArguments(["--url", "http://127.0.0.1:8787/mcp"]).url,
    "http://127.0.0.1:8787/mcp",
  );
});

test("rejects malformed bearer token environment values", async () => {
  await assert.rejects(
    runMcpStdioBridge(["--url", "https://mcp.example.test/mcp"], {
      env: { MEKKA_MCP_TOKEN: "secret\r\nInjected: header" },
    }),
    /environment variable is malformed/,
  );
});

test("bridges an MCP stdio client to an authenticated Streamable HTTP endpoint", async () => {
  const bearerToken = "integration-secret-token";
  const authorizations = [];
  const endpoint = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== `Bearer ${bearerToken}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }

    const body = await readRequestBody(request);
    const webRequest = new Request(`http://127.0.0.1:${endpoint.address().port}/mcp`, {
      method: request.method,
      headers: request.headers,
      body,
      duplex: "half",
    });
    const mcpServer = new McpServer({ name: "mock-streamable-http", version: "1.0.0" });
    mcpServer.registerTool("echo", { inputSchema: { value: z.string() } }, async ({ value }) => ({
      content: [{ type: "text", text: value }],
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await mcpServer.connect(transport);
    const webResponse = await transport.handleRequest(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  });

  await new Promise((resolve, reject) => {
    endpoint.once("error", reject);
    endpoint.listen(0, "127.0.0.1", resolve);
  });
  const address = endpoint.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./mekka.js", import.meta.url)),
      "mcp-stdio",
      "--url",
      `http://127.0.0.1:${address.port}/mcp`,
      "--token-env",
      "BRIDGE_TEST_TOKEN",
    ],
    env: { ...process.env, BRIDGE_TEST_TOKEN: bearerToken },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-bridge-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["echo"],
    );
    const result = await client.callTool({ name: "echo", arguments: { value: "bridged" } });
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "bridged");
    assert.ok(authorizations.length >= 3);
    assert.ok(authorizations.every((authorization) => authorization === `Bearer ${bearerToken}`));
  } finally {
    await client.close();
    await new Promise((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
