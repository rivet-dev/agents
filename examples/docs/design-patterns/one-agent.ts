import { createClient } from "rivetkit/client";
import type { registry } from "./agent-per-key/server";

const client = createClient<typeof registry>();

export async function answer(userId: string, message: string) {
	const assistant = client.assistant.getOrCreate(["support"]);
	await assistant.prompt(`${userId}: ${message}`);
	return assistant.getLastAssistantText();
}
