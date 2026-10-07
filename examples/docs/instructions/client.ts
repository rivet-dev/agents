import { readFile } from "node:fs/promises";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["payments", "pr-482"]);

// Instructions for this conversation only. They go after the extension sections.
const root = await agent.harness.root();
await agent.conversation.configure(root.id, {
	instructions: "This conversation is about pr-482 in https://github.com/acme/payments. Focus on the checkout flow.",
});

// Context for one prompt goes in the prompt itself, text and images.
const screenshot = await readFile("checkout-error.png");
const result = await agent.prompt([
	{ type: "text", text: "Clone the repository and check out pr-482. This error shows up at checkout after that PR. Which change causes it?" },
	{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" },
]);

console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
