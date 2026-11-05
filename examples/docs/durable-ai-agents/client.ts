import { createInterface } from "node:readline";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// Run with the same conversation id again to reopen it, like a reload.
const conversationId = process.argv[2] ?? crypto.randomUUID();
console.log(`Conversation ${conversationId}`);

const client = createClient<typeof registry>();
const conn = client.chatAgent.getOrCreate([conversationId]).connect();

// docs:start stream
let view: ConversationView | undefined;
// Operations that arrive before the watch call returns.
const early: Op[] = [];
// What is already printed.
let printed = "";
const shownTools = new Set<string>();

conn.on("pi.view", (frame) => {
	// RivetKit types event payloads as unknown, so name the frame's type.
	const { value, ops = [] } = frame as PiViewFrame;
	// A value replaces everything, such as when the agent restarts after a crash.
	if (value) {
		console.log("\n[resumed]");
		view = value;
	} else if (view) view = applyImmutable(view, ops);
	else early.push(...ops);
	if (view) show(view);
});

function show(current: ConversationView) {
	const live = current.docs["pi.live"] as LiveState;
	for (const tool of live.tools ?? []) {
		if (shownTools.has(tool.callId)) continue;
		shownTools.add(tool.callId);
		console.log(`\n> ${tool.name}`);
	}
	// The answer in progress, or the newest entry once it is finished.
	const last = current.entries.at(-1)?.model?.[0];
	const answer = live.generation?.message ?? (last?.role === "assistant" ? last : undefined);
	const text = answer ? contentText(answer.content, "") : "";
	if (!text.startsWith(printed)) printed = "";
	process.stdout.write(text.slice(printed.length));
	printed = text;
}
// docs:end stream

// docs:start resume
// Prints the newest messages and the answer in progress, then streams the rest.
const root = await conn.harness.root();
const { value } = await conn.conversation.watch(root.id);
view = applyImmutable(value, early);
for (const entry of view.entries) {
	const message = entry.model?.[0];
	if (message?.role === "user") console.log(`you: ${contentText(message.content, "")}`);
	if (message?.role === "assistant") {
		printed = contentText(message.content, "");
		if (printed) console.log(`agent: ${printed}`);
	}
}
show(view);
// docs:end resume

// docs:start send
// Each line you type goes to the agent. submit saves it and returns without waiting for the answer.
for await (const text of createInterface({ input: process.stdin })) {
	// One id per message. Resending the message with the same id doesn't run the agent twice.
	const requestId = crypto.randomUUID();
	await conn.submit(text, { requestId });
}
// docs:end send
