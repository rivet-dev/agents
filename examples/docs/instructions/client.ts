import { readFile } from "node:fs/promises";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["payments", "pr-482"]);

const screenshot = await readFile("checkout-error.png");

await agent.prompt("Clone https://github.com/acme/payments and check out pr-482. This error shows up at checkout after that PR. Which change causes it?", {
	images: [{ type: "image", data: screenshot.toString("base64"), mimeType: "image/png" }],
});
console.log(await agent.getLastAssistantText());
