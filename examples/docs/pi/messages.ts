import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["user-123"]);

const root = await agent.harness.root();
const { messages } = await agent.conversation.context(root.id);

// The messages are pi-ai messages: user, assistant, and toolResult.
const answers = messages.filter(
	(message): message is AssistantMessage => message.role === "assistant",
);
for (const answer of answers) {
	const text = answer.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("");
	const { totalTokens, cost } = answer.usage;
	console.log(`${answer.model}, ${totalTokens} tokens, $${cost.total}: ${text}`);
}
