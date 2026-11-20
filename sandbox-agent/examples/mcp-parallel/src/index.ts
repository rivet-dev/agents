import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpServerConfig, SandboxAgent, SandboxAgentError } from "sandbox-agent";

const [baseUrl, directory] = process.argv.slice(2);
if (!baseUrl || !directory) {
  throw new Error("Usage: pnpm start <sandbox-agent-url> <absolute-directory-on-server>");
}

const query = { directory, mcpName: "parallel-search" };
const config: McpServerConfig = {
  type: "remote",
  url: "https://search.parallel.ai/mcp",
  transport: "http",
  headers: { "User-Agent": "rivet-dev/agents-mcp-parallel-example" },
  timeoutMs: 60_000,
};
const sdk = await SandboxAgent.connect({ baseUrl, token: process.env.SANDBOX_TOKEN });
const mcp = new Client({ name: "rivet-dev/agents-mcp-parallel-example", version: "1.0.0" });

try {
  let existing: McpServerConfig | undefined;
  try {
    existing = await sdk.getMcpConfig(query);
  } catch (error) {
    if (!(error instanceof SandboxAgentError) || error.status !== 404) throw error;
  }
  if (existing && !isDeepStrictEqual(existing, config)) {
    throw new Error("A different parallel-search config already exists. Choose another directory or remove that entry first.");
  }
  if (!existing) await sdk.setMcpConfig(query, config);

  // Use the stored configuration, rather than connecting with an unrelated preset.
  const stored = await sdk.getMcpConfig(query);
  if (stored.type !== "remote" || !isDeepStrictEqual(stored, config)) {
    throw new Error("The stored Parallel configuration does not match the anonymous HTTP preset.");
  }
  console.log(`Loaded ${query.mcpName} for ${directory}.`);
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(stored.url), {
      requestInit: { headers: stored.headers ?? undefined },
    }),
  );

  const tools = await mcp.listTools();
  for (const name of ["web_search", "web_fetch"]) {
    if (!tools.tools.some((tool) => tool.name === name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  const sessionId = randomUUID();
  const calls = [
    {
      name: "web_search",
      arguments: {
        objective: "Find the official Rivet documentation for durable actors.",
        search_queries: ["Rivet durable actors documentation"],
        session_id: sessionId,
      },
    },
    {
      name: "web_fetch",
      arguments: {
        urls: ["https://rivet.dev/docs"],
        objective: "Explain what Rivet actors do.",
        session_id: sessionId,
      },
    },
  ];
  for (const call of calls) {
    const result = await mcp.callTool(call, undefined, { timeout: stored.timeoutMs ?? undefined });
    if (result.isError) throw new Error(`${call.name} failed: ${JSON.stringify(result.content)}`);
    console.log(`${call.name}:`);
    console.log(JSON.stringify(result.content, null, 2));
  }
} finally {
  await mcp.close();
  await sdk.dispose();
}
