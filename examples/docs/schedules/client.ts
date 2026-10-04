import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const agent = client.agent.getOrCreate(["acme/app", "morning-triage"]);

// The first call creates the agent, and onCreate sets its cron.
await agent.resolve();

// Any time after a run, read the latest summary.
const summary = await agent.getLastAssistantText();
console.log(summary ?? "No run yet. The first one starts at 9:00 UTC.");
