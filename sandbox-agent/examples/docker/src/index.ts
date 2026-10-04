import fs from "node:fs";
import path from "node:path";
import { SandboxAgent } from "sandbox-agent";
import { docker } from "sandbox-agent/docker";
import { detectAgent } from "@sandbox-agent/example-shared";
import { FULL_IMAGE } from "@sandbox-agent/example-shared/docker";

const codexAuthPath = process.env.HOME ? path.join(process.env.HOME, ".codex", "auth.json") : null;
const bindMounts = codexAuthPath && fs.existsSync(codexAuthPath) ? [`${codexAuthPath}:/home/sandbox/.codex/auth.json:ro`] : [];
const env = [
  process.env.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}` : "",
  process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}` : "",
  process.env.CODEX_API_KEY ? `CODEX_API_KEY=${process.env.CODEX_API_KEY}` : "",
].filter(Boolean);

const client = await SandboxAgent.start({
  sandbox: docker({
    image: FULL_IMAGE,
    env,
    binds: bindMounts,
  }),
});

console.log(`UI: ${client.inspectorUrl}`);

const session = await client.createSession({
  agent: detectAgent(),
  cwd: "/home/sandbox",
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from Docker in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
