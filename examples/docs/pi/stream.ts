import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const conn = client.agent.getOrCreate(["user-123"]).connect();

// The text of the current answer printed so far.
let printed = "";

conn.on("pi.events", ({ events }) => {
	for (const event of events) {
		if (event.type === "message_update") {
			for (const change of event.changes) {
				if (change.type === "text_delta") {
					process.stdout.write(change.delta);
					printed += change.delta;
				}
			}
		}
		if (event.type === "message_end") {
			// A short answer can arrive whole here, with no text_delta before it.
			const message = event.entry.model?.[0];
			if (message?.role === "assistant") {
				const text = message.content
					.flatMap((block) => (block.type === "text" ? [block.text] : []))
					.join("");
				process.stdout.write(text.slice(printed.length));
			}
			printed = "";
		}
		if (event.type === "tool_execution_start") console.log(`\n> ${event.toolName}`);
	}
});

const root = await conn.harness.root();
await conn.conversation.watchEvents(root.id);

await conn.prompt("Write an isPalindrome function in TypeScript, add tests for it, and run them.");
await conn.dispose();
