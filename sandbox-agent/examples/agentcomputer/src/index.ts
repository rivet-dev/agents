import { SandboxAgent } from "sandbox-agent";
import { agentcomputer } from "sandbox-agent/agentcomputer";

const client = await SandboxAgent.start({
  sandbox: agentcomputer(),
});

console.log(`UI: ${client.inspectorUrl}`);

const health = await client.getHealth();
console.log(`Health: ${health.status}`);

const agents = await client.listAgents();
console.log("Agents:", agents.agents.map((agent) => agent.id).join(", "));

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
