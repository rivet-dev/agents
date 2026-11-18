import { createInterface } from "node:readline";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { contentText } from "@earendil-works/pi-ai";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// One agent per key. Pass a key to pick up an earlier session: `npx tsx cli.ts my-session`.
const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate([process.argv[2] ?? "demo"]).connect();

// Status the agent sends from the sandbox through call-tool.sh.
agent.on("progress", (message) => console.log(`\n[progress] ${message}`));

// Everything else the agent does: its answer as it streams, and each tool it runs.
let view: ConversationView | undefined;
// Operations that arrive before the watch call returns.
const early: Op[] = [];
let printed = "";
const shownTools = new Set<string>();
agent.on("pi.view", (frame) => {
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
	// The answer in progress, or the newest entry once it is finished.
	const last = current.entries.at(-1)?.model?.[0];
	const answer = live.generation?.message ?? (last?.role === "assistant" ? last : undefined);
	const text = answer ? contentText(answer.content, "") : "";
	if (!text.startsWith(printed)) printed = "";
	process.stdout.write(text.slice(printed.length));
	printed = text;
}

const { value } = await agent.conversation.watch((await agent.harness.root()).id);
view = applyImmutable(value, early);
show(view);

// Reads one prompt per line until Ctrl-D.
const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "\nyou> " });
let closed = false;
input.on("close", () => (closed = true));
input.prompt();
for await (const line of input) {
	if (line.trim()) {
		const result = await agent.prompt(line, { requestId: crypto.randomUUID() });
		if (result.status === "unanswered") console.log(`\n(no answer: ${result.reason})`);
		console.log(`\nnotes: ${JSON.stringify(await agent.listNotes())}`);
	}
	if (!closed) input.prompt();
}
await agent.dispose();
