import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["support", "customer-123"]);

const root = await agent.harness.root();
const { messages } = await agent.conversation.context(root.id);
console.log(`${messages.length} messages so far`);

const conn = agent.connect();
conn.onStatusChange((status) => console.log(`[connection ${status}]`));

let view: ConversationView | undefined;
// Operations that arrive before the watch call returns.
const early: Op[] = [];
// What is already printed.
let printed = "";
const shownTools = new Set<string>();
let retryAt: number | undefined;

const unsubscribe = conn.on("pi.view", (frame) => {
	// RivetKit types event payloads as unknown, so name the frame's type.
	const { value, ops = [] } = frame as PiViewFrame;
	if (value) view = value;
	else if (view) view = applyImmutable(view, ops);
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
	const retry = live.generation?.retry;
	if (retry && retry.at !== retryAt) console.log(`\nRetrying: ${retry.error}`);
	retryAt = retry?.at;
	// The answer in progress, or the newest entry once it is finished.
	const last = current.entries.at(-1)?.model?.[0];
	const answer = live.generation?.message ?? (last?.role === "assistant" ? last : undefined);
	const text = answer ? contentText(answer.content, "") : "";
	if (!text.startsWith(printed)) printed = "";
	process.stdout.write(text.slice(printed.length));
	printed = text;
}

// Sends this conversation's view to this connection.
const { value } = await conn.conversation.watch(root.id);
view = applyImmutable(value, early);
show(view);

const result = await conn.prompt("Clone https://github.com/honojs/hono and summarize its README.", {
	requestId: crypto.randomUUID(),
});
if (result.status === "unanswered") console.error(`\nNo answer: ${result.reason}`);

unsubscribe();
await conn.dispose();
