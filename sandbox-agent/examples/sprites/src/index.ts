import { SandboxAgent } from "sandbox-agent";
import { sprites } from "sandbox-agent/sprites";

const env: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = await SandboxAgent.start({
  sandbox: sprites({
    token: process.env.SPRITES_API_KEY ?? process.env.SPRITE_TOKEN ?? process.env.SPRITES_TOKEN,
    env,
  }),
});

console.log(`UI: ${client.inspectorUrl}`);
console.log(await client.getHealth());

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
