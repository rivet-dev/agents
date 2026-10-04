import { SandboxAgent } from "sandbox-agent";
import { daytona } from "sandbox-agent/daytona";
import { detectAgent } from "@sandbox-agent/example-shared";

const envVars: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = await SandboxAgent.start({
  sandbox: daytona({
    create: { envVars },
  }),
});

console.log(`UI: ${client.inspectorUrl}`);

const session = await client.createSession({
  agent: detectAgent(),
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from Daytona in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
