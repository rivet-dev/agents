import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["user-123"]);

const result = await agent.prompt(
	"Write a hello-world Rivet Actor to counter.ts, then read the file back to me.",
	{ requestId: crypto.randomUUID() },
);

console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
