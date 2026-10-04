import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";

console.log("Starting sandbox...");
const { baseUrl, cleanup } = await startDockerSandbox({
  port: 3002,
  setupCommands: ["npm install -g --silent @modelcontextprotocol/server-everything@2026.1.26"],
});

console.log("Creating session with everything MCP server...");
const client = await SandboxAgent.connect({ baseUrl });
const session = await client.createSession({
  agent: detectAgent(),
  sessionInit: {
    cwd: "/root",
    mcpServers: [
      {
        name: "everything",
        command: "mcp-server-everything",
        args: [],
        env: [],
      },
    ],
  },
});
const sessionId = session.id;
console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log('  Try: "generate a random number between 1 and 100"');
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", () => {
  clearInterval(keepAlive);
  cleanup().then(() => process.exit(0));
});
