import { createClient } from "rivetkit/client";
import type { registry } from "../quickstart/server";

const client = createClient<typeof registry>();
const conn = client.agent.getOrCreate(["user-123"]).connect();

conn.on("event", (event) => {
	if (event.type === "turn_start") console.log("\n[turn]");
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
	if (event.type === "turn_end" && event.message.role === "assistant") {
		console.log(`\n[${event.message.usage.totalTokens} tokens]`);
	}
	if (event.type === "compaction_start") console.log("\n[compacting]");
});

await conn.prompt("Write an isPalindrome function in TypeScript, add tests for it, and run them.");
await conn.dispose();
