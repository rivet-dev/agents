import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["support", "customer-123"]);

const root = await agent.harness.root();
const { messages } = await agent.conversation.context(root.id);
console.log(`${messages.length} messages so far`);

const conn = agent.connect();
conn.onStatusChange((status) => console.log(`[connection ${status}]`));

// The text of the current answer printed so far.
let printed = "";

const unsubscribe = conn.on("pi.events", ({ events }) => {
	for (const event of events) {
		switch (event.type) {
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta") {
						process.stdout.write(change.delta);
						printed += change.delta;
					}
				}
				break;
			case "message_end": {
				// A short answer can arrive whole here, with no text_delta before it.
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") {
					const text = message.content
						.flatMap((block) => (block.type === "text" ? [block.text] : []))
						.join("");
					process.stdout.write(text.slice(printed.length));
				}
				printed = "";
				break;
			}
			case "tool_execution_start":
				console.log(`\n> ${event.toolName}`);
				break;
			case "auto_retry_start":
				console.log(`\nRetrying (attempt ${event.attempt}): ${event.errorMessage}`);
				break;
		}
	}
});
// Sends this conversation's events to this connection.
await conn.conversation.watchEvents(root.id);

const result = await conn.prompt("Clone https://github.com/honojs/hono and summarize its README.", {
	requestId: crypto.randomUUID(),
});
if (result.status === "unanswered") console.error(`\nNo answer: ${result.reason}`);

unsubscribe();
await conn.dispose();
