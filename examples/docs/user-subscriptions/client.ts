import type { Credential } from "@earendil-works/pi-ai";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// Called from your settings page with the user's own key or the result of a subscription login.
export async function saveLogin(userId: string, provider: string, credential: Credential) {
	await client.credentials.getOrCreate([userId]).save(provider, credential);
}

// The agent's key starts with the user id, so it runs on that user's credential.
export async function chat(userId: string, text: string) {
	const result = await client.agent.getOrCreate([userId, "chat"]).prompt(text);
	return result.status === "done" ? result.text : undefined;
}
