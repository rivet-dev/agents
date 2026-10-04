import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";

console.log("Starting sandbox...");
const { baseUrl, cleanup } = await startDockerSandbox({
  port: 3001,
});

console.log("Configuring skill source...");
const client = await SandboxAgent.connect({ baseUrl });
await client.setSkillsConfig(
  { directory: "/", skillName: "rivet-dev-skills" },
  { sources: [{ type: "github", source: "rivet-dev/skills", skills: ["sandbox-agent"] }] },
);

console.log("Creating session...");
const session = await client.createSession({ agent: detectAgent(), cwd: "/root" });
const sessionId = session.id;
console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log('  Try: "How do I start sandbox-agent?"');
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", () => {
  clearInterval(keepAlive);
  cleanup().then(() => process.exit(0));
});
