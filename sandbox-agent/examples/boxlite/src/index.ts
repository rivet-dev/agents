import { SimpleBox } from "@boxlite-ai/boxlite";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { setupImage, OCI_DIR } from "./setup-image.ts";

const env: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

setupImage();

console.log("Creating BoxLite sandbox...");
const box = new SimpleBox({
  rootfsPath: OCI_DIR,
  env,
  ports: [{ hostPort: 3000, guestPort: 3000 }],
  diskSizeGb: 4,
});

console.log("Starting server...");
const result = await box.exec("sh", "-c", "nohup sandbox-agent server --no-token --host 0.0.0.0 --port 3000 >/tmp/sandbox-agent.log 2>&1 &");
if (result.exitCode !== 0) throw new Error(`Failed to start server: ${result.stderr}`);

const baseUrl = "http://localhost:3000";

console.log("Connecting to server...");
const client = await SandboxAgent.connect({ baseUrl });
const session = await client.createSession({ agent: detectAgent(), cwd: "/root" });
const sessionId = session.id;

console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
const cleanup = async () => {
  clearInterval(keepAlive);
  await box.stop();
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
