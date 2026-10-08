import { createInterface } from "node:readline/promises";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const userId = "user-123";

// 1. Start the sign-in and send the user to ChatGPT.
const login = client.chatgptLogin.getOrCreate([userId]);
const url = await login.start();
console.log(`Open this URL and choose Continue:\n${url}\n`);

// 2. The browser lands on a 127.0.0.1 URL. The user copies it from the address bar.
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const redirect = await terminal.question("Paste the URL you landed on, or press Enter if the page says you can close it: ");
terminal.close();
await login.finish(redirect.trim() || undefined);

// 3. The agent now runs on the user's ChatGPT plan.
const result = await client.agent.getOrCreate([userId, "chat"]).prompt("Say hi in five words.");
console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
