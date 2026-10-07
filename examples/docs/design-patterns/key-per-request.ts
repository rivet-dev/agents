import { createClient } from "rivetkit/client";
import type { registry } from "./agent-per-key/server";

const client = createClient<typeof registry>();

export async function answer(message: string) {
	const result = await client.assistant.getOrCreate([crypto.randomUUID()]).prompt(message);
	return result.status === "done" ? result.text : undefined;
}
