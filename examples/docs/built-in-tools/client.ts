import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const writer = client.writer.getOrCreate(["docs-123"]);

await writer.prompt("Write a README.md for a command-line todo app.");
const result = await writer.prompt("Add an Install section to README.md.");

console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
