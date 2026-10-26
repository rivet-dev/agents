import { createInterface } from "node:readline";
import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import type { SnapshotEvent } from "@earendil-works/pi-durable";
import type { PiEventsFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// Run with the same conversation id again to reopen it, like a reload.
const conversationId = process.argv[2] ?? crypto.randomUUID();
console.log(`Conversation ${conversationId}`);

const client = createClient<typeof registry>();
const conn = client.chatAgent.getOrCreate([conversationId]).connect();

// docs:start stream
// The text of the current answer printed so far.
let printed = "";

conn.on("pi.events", (frame) => {
	// RivetKit types event payloads as unknown, so name the frame's type.
	for (const event of (frame as PiEventsFrame).events) {
		// The agent restarted, such as after a crash, and sent a fresh snapshot.
		if (event.type === "snapshot") {
			console.log("\n[resumed]");
			showPartialAnswer(event);
		}
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
			if (message?.role === "assistant") process.stdout.write(textOf(message).slice(printed.length));
			printed = "";
		}
		if (event.type === "tool_execution_start") console.log(`\n> ${event.toolName}`);
		if (event.type === "run_end") console.log("\n");
	}
});
// docs:end stream

// docs:start resume
// Prints the conversation so far and the answer in progress, then streams the rest.
const root = await conn.harness.root();
const { snapshot } = await conn.conversation.watchEvents(root.id);
for (const entry of snapshot.entries) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(`you: ${contentText(message.content, "")}`);
	if (message?.role === "assistant" && textOf(message)) console.log(`agent: ${textOf(message)}`);
}
showPartialAnswer(snapshot);

function showPartialAnswer(snapshot: SnapshotEvent) {
	const partial = snapshot.generation?.message;
	printed = partial ? textOf(partial) : "";
	process.stdout.write(printed);
}
// docs:end resume

// docs:start send
// Each line you type goes to the agent. submit saves it and returns without waiting for the answer.
for await (const text of createInterface({ input: process.stdin })) {
	// One id per message. Resending the message with the same id doesn't run the agent twice.
	const requestId = crypto.randomUUID();
	await conn.submit(text, { requestId });
}
// docs:end send

function textOf(message: AssistantMessage) {
	return contentText(message.content, "");
}
