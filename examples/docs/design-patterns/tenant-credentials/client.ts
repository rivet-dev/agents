import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// Called from your settings page when a tenant admin saves the team's Anthropic key.
export async function saveTeamKey(tenantId: string, anthropicKey: string) {
	await client.credentials.getOrCreate([tenantId]).save("anthropic", { type: "api_key", key: anthropicKey });
}

// Every agent keyed under the tenant uses that key, and never sees another tenant's.
export async function ask(tenantId: string, userId: string, text: string) {
	const agent = client.agent.getOrCreate([tenantId, userId]);
	await agent.prompt(text);
	return agent.getLastAssistantText();
}
