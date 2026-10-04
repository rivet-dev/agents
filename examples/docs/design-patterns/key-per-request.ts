import { createClient } from "rivetkit/client";
import type { registry } from "./agent-per-key/server";

const client = createClient<typeof registry>();

export async function answer(message: string) {
	const assistant = client.assistant.getOrCreate([crypto.randomUUID()]);
	await assistant.prompt(message);
	return assistant.getLastAssistantText();
}
