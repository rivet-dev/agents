import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "../quickstart/server";

const client = createClient<typeof registry>();
const conn = client.agent.getOrCreate(["user-123"]).connect();

let view: ConversationView | undefined;
// Operations that arrive before the watch call returns.
const early: Op[] = [];
// What is already printed.
let printed = "";
let running = false;
let compacting = false;
const shownTools = new Set<string>();

conn.on("pi.view", (frame) => {
	// RivetKit types event payloads as unknown, so name the frame's type.
	const { value, ops = [] } = frame as PiViewFrame;
	if (value) view = value;
	else if (view) view = applyImmutable(view, ops);
	else early.push(...ops);
	if (view) show(view);
});

function show(current: ConversationView) {
	const live = current.docs["pi.live"] as LiveState;
	if (!running && live.run) console.log("[run]");
	for (const tool of live.tools ?? []) {
		if (shownTools.has(tool.callId)) continue;
		shownTools.add(tool.callId);
		console.log(`\n> ${tool.name}`);
	}
	if (!compacting && live.compactions?.length) console.log("\n[compacting]");
	compacting = Boolean(live.compactions?.length);
	// The answer in progress, or the newest entry once it is finished.
	const last = current.entries.at(-1)?.model?.[0];
	const answer = live.generation?.message ?? (last?.role === "assistant" ? last : undefined);
	const text = answer ? contentText(answer.content, "") : "";
	if (!text.startsWith(printed)) printed = "";
	process.stdout.write(text.slice(printed.length));
	printed = text;
	if (running && !live.run) console.log("\n[done]");
	running = live.run !== undefined;
}

const root = await conn.harness.root();
const { value } = await conn.conversation.watch(root.id);
view = applyImmutable(value, early);
show(view);

await conn.prompt("Write an isPalindrome function in TypeScript to palindrome.ts, and add tests for it in palindrome.test.ts.");
await conn.dispose();
