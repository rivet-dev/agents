import { SandboxAgent } from "sandbox-agent";
import { SQLiteSessionPersistDriver } from "./persist.ts";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import { detectAgent } from "@sandbox-agent/example-shared";

const persist = new SQLiteSessionPersistDriver({ filename: "./sessions.db" });

console.log("Starting sandbox...");
const sandbox = await startDockerSandbox({
  port: 3000,
});

const sdk = await SandboxAgent.connect({ baseUrl: sandbox.baseUrl, persist });

const session = await sdk.createSession({ agent: detectAgent() });
console.log(`Created session ${session.id}`);

await session.prompt([{ type: "text", text: "Say hello in one sentence." }]);
console.log("Prompt complete.");

const sessions = await sdk.listSessions();
console.log(`\nSessions (${sessions.items.length}):`);
for (const s of sessions.items) {
  console.log(`  ${s.id}  agent=${s.agent}`);
}

const events = await sdk.getEvents({ sessionId: session.id });
console.log(`\nSession history (${events.items.length} events):`);
for (const e of events.items) {
  console.log(`  [${e.eventIndex}] ${e.sender}: ${JSON.stringify(e.payload).slice(0, 120)}`);
}

persist.close();
await sdk.dispose();
await sandbox.cleanup();
