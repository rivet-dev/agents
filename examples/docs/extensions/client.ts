import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["acme", "checkout-review"]);
const root = await agent.harness.root();

// Add read-only to this conversation only. Extensions are passed by name.
await agent.conversation.configure(root.id, { extensions: { add: ["read-only"] } });
const answer = await agent.prompt("Where are checkout totals computed?");
console.log(answer.status === "done" ? answer.text : `Unanswered: ${answer.reason}`);

// Go back to the default selection, CodingTools and audit.
await agent.conversation.configure(root.id, { extensions: null });
const { extensions } = await agent.conversation.agent(root.id);
console.log(extensions); // ["coding-tools", "audit"]
