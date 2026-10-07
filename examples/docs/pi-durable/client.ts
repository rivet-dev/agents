import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["user-123"]);

const result = await agent.prompt(
	"Write a Python script that prints the first 20 prime numbers, run it, and show me the output.",
	{ requestId: crypto.randomUUID() },
);

console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
