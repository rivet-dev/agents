import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["support", "customer-123"]);

const history = await agent.getMessages();
console.log(`${history.length} messages so far`);

const conn = agent.connect();
conn.onStatusChange((status) => console.log(`[connection ${status}]`));

const unsubscribe = conn.on("event", (event) => {
	switch (event.type) {
		case "message_update":
			if (event.assistantMessageEvent.type === "text_delta") {
				process.stdout.write(event.assistantMessageEvent.delta);
			}
			break;
		case "tool_execution_start":
			console.log(`\n> ${event.toolName}`);
			break;
		case "tool_execution_end":
			console.log(event.isError ? "  failed" : "  done");
			break;
		case "auto_retry_start":
			console.log(`\nRetrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
			break;
	}
});

await conn.prompt("Clone https://github.com/honojs/hono and summarize its README.");

const last = (await conn.getMessages()).at(-1);
if (last?.role === "assistant" && last.stopReason === "error") {
	console.error(`\nModel error: ${last.errorMessage}`);
}

unsubscribe();
await conn.dispose();
