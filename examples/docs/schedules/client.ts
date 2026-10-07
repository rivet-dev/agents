import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["acme/app", "morning-triage"]);

// The first call creates the agent, and onCreate sets its cron.
const root = await agent.harness.root();

// Any time after a run, read the latest summary: the last message of the conversation.
const { messages } = await agent.conversation.context(root.id);
const last = messages.at(-1);
let summary = "";
if (last?.role === "assistant") {
	for (const block of last.content) if (block.type === "text") summary += block.text;
}
console.log(summary || "No run yet. The first one starts at 9:00 UTC.");
