import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Verify the bundled script exists (built by `pnpm build:script`).
const scriptFile = path.resolve(__dirname, "../dist/random-number.cjs");
if (!fs.existsSync(scriptFile)) {
  console.error("Error: dist/random-number.cjs not found. Run `pnpm build:script` first.");
  process.exit(1);
}

// Start a Docker container running sandbox-agent.
console.log("Starting sandbox...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3005 });

// Upload the bundled script and SKILL.md into the sandbox filesystem.
console.log("Uploading script and skill file...");
const client = await SandboxAgent.connect({ baseUrl });

const script = await fs.promises.readFile(scriptFile);
const scriptResult = await client.writeFsFile({ path: "/opt/skills/random-number/random-number.cjs" }, script);
console.log(`  Script: ${scriptResult.path} (${scriptResult.bytesWritten} bytes)`);

const skillMd = await fs.promises.readFile(path.resolve(__dirname, "../SKILL.md"));
const skillResult = await client.writeFsFile({ path: "/opt/skills/random-number/SKILL.md" }, skillMd);
console.log(`  Skill:  ${skillResult.path} (${skillResult.bytesWritten} bytes)`);

// Configure the uploaded skill.
console.log("Configuring custom skill...");
await client.setSkillsConfig({ directory: "/", skillName: "random-number" }, { sources: [{ type: "local", source: "/opt/skills/random-number" }] });

// Create a session.
console.log("Creating session with custom skill...");
const session = await client.createSession({ agent: detectAgent(), cwd: "/root" });
const sessionId = session.id;
console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log('  Try: "generate a random number between 1 and 100"');
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGINT", () => {
  clearInterval(keepAlive);
  cleanup().then(() => process.exit(0));
});
