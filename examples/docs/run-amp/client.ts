import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// One Actor per session. Use the same id later to come back to this session.
const session = client.ampSession.getOrCreate(["session-123"]).connect();

// Amp's events arrive while it works.
session.on("output", (event) => console.log(JSON.stringify(event)));

const answer = await session.prompt("Write fib.py that prints the first 10 Fibonacci numbers, then run it.");
console.log(`\nAnswer: ${answer}`);

// The follow-up runs in the same sandbox and continues the same Amp thread.
const followUp = await session.prompt("Make it print 20 numbers and run it again.");
console.log(`\nAnswer: ${followUp}`);

await session.dispose();
