import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { actor, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";
import { db } from "rivetkit/db";

export const deploy = defineTool({
	name: "deploy",
	description:
		"Deploy a version to production. Every deploy needs a person's approval: call it without approvalId to ask for one.",
	parameters: obj({ version: str(), approvalId: opt(str()) }),
	execute: async ({ version, approvalId }, _api, context) => {
		if (approvalId === undefined) {
			const id = crypto.randomUUID();
			await client.approval.getOrCreate([id]).request(version);
			const text = `Waiting for a person to approve deploying ${version}. After approval, call deploy again with approvalId ${id}.`;
			// Ends the run, so the agent waits for the person instead of trying again.
			return { output: [{ type: "text", text }], details: { version, approvalId: id }, control: { terminate: true } };
		}
		if (!(await client.approval.get([approvalId]).consume(version))) {
			throw new Error(`Deploying ${version} is not approved.`);
		}
		await fetch(`https://deploy.example.com/releases/${version}`, { method: "POST", signal: context.abortSignal });
		return { output: [{ type: "text", text: `Deployed ${version}.` }] };
	},
});

// One per approval, keyed by its id.
export const approval = actor({
	db: db({
		onMigrate: async (db) => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS approval (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL, approved INTEGER NOT NULL)",
			);
			await db.execute("INSERT OR IGNORE INTO approval (id, version, approved) VALUES (1, '', 0)");
		},
	}),
	actions: {
		request: async (c, version: string) => {
			await c.db.execute("UPDATE approval SET version = ? WHERE id = 1", version);
		},
		approve: async (c) => {
			await c.db.execute("UPDATE approval SET approved = 1 WHERE id = 1");
		},
		// Any call uses up the approval, so it can never deploy twice.
		consume: async (c, version: string) => {
			const [used] = await c.db.execute<{ version: string }>(
				"UPDATE approval SET approved = 0 WHERE id = 1 AND approved = 1 RETURNING version",
			);
			return used?.version === version;
		},
	},
});

const client = createClient<Registry<{ approval: typeof approval }>>();
