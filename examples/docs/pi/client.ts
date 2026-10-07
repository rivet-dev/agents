import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["user-123"]);

const result = await agent.prompt(
	"Write a Python script that rolls two dice 10,000 times, run it, and show me how often each total came up.",
	{ requestId: crypto.randomUUID() },
);

console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
