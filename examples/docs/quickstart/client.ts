import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["user-123"]);

const conn = agent.connect();

await conn.prompt("Write a Python script that prints the first 20 prime numbers, run it, and show me the output.");
console.log(await conn.getLastAssistantText());

await conn.dispose();
