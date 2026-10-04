import { createClient } from "rivetkit/client";
import type { registry } from "./server";

async function fetchAgentToken(): Promise<{ agentId: string; token: string }> {
	const response = await fetch("/agent-token", { method: "POST", cache: "no-store" });
	if (!response.ok) throw new Error("Could not get an agent token.");
	return (await response.json()) as { agentId: string; token: string };
}

const { agentId } = await fetchAgentToken();

const client = createClient<typeof registry>({
	endpoint: "https://api.rivet.dev",
	namespace: "production",
	getToken: async () => (await fetchAgentToken()).token,
});

const conn = client.agent.getForId(agentId).connect();
await conn.prompt("Clone https://github.com/honojs/hono and summarize its README.");
console.log(await conn.getLastAssistantText());
