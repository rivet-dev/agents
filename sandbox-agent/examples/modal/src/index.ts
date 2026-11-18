import { SandboxAgent } from "sandbox-agent";
import { modal } from "sandbox-agent/modal";
import { detectAgent } from "@sandbox-agent/example-shared";

const secrets: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) secrets.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = await SandboxAgent.start({
  sandbox: modal({
    create: { secrets },
  }),
});

console.log(`UI: ${client.inspectorUrl}`);

const session = await client.createSession({
  agent: detectAgent(),
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from Modal in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
