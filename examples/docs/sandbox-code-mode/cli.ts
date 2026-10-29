import { createInterface } from "node:readline";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// One agent per key. Pass a key to pick up an earlier session: `npx tsx cli.ts my-session`.
const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate([process.argv[2] ?? "demo"]).connect();

// Status the agent sends from the sandbox through call-tool.sh.
agent.on("progress", (message) => console.log(`\n[progress] ${message}`));

// Everything else the agent does: its answer as it streams, and each tool it runs.
let streamed = false;
agent.on("pi.events", ({ events }) => {
	for (const event of events) {
		if (event.type === "message_update") {
			for (const change of event.changes) {
				if (change.type === "text_delta") {
					process.stdout.write(change.delta);
					streamed = true;
				}
			}
		}
		if (event.type === "tool_execution_start") {
			const call = event.toolName === "bash" ? `$ ${event.args.command}` : `${event.toolName} ${JSON.stringify(event.args)}`;
			console.log(`\n> ${call}`);
		}
	}
});
await agent.conversation.watchEvents((await agent.harness.root()).id);

// Reads one prompt per line until Ctrl-D.
const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nyou> " });
let closed = false;
input.on("close", () => (closed = true));
input.prompt();
for await (const line of input) {
	if (line.trim()) {
		streamed = false;
		const result = await agent.prompt(line, { requestId: crypto.randomUUID() });
		if (result.status === "unanswered") console.log(`\n(no answer: ${result.reason})`);
		// A short answer can arrive whole, without streaming.
		else if (!streamed) console.log(result.text);
		console.log(`\nnotes: ${JSON.stringify(await agent.listNotes())}`);
	}
	if (!closed) input.prompt();
}
await agent.dispose();
