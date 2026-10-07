import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { actor, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";

export const deploy = defineTool({
	name: "deploy",
	description:
		"Deploy a version to production. Every deploy needs a person's approval: call it without approvalId to ask for one.",
	parameters: Type.Object({ version: Type.String(), approvalId: Type.Optional(Type.String()) }),
	execute: async ({ version, approvalId }, _api, context) => {
		if (approvalId === undefined) {
			const id = crypto.randomUUID();
			await client.approval.getOrCreate([id]).request(version);
			const text = `Waiting for a person to approve deploying ${version}. After approval, call deploy again with approvalId ${id}.`;
			// Ends the run, so the agent waits for the person instead of trying again.
			return { content: [{ type: "text", text }], details: { version, approvalId: id }, control: { terminate: true } };
		}
		if (!(await client.approval.get([approvalId]).consume(version))) {
			throw new Error(`Deploying ${version} is not approved.`);
		}
		await fetch(`https://deploy.example.com/releases/${version}`, { method: "POST", signal: context.abortSignal });
		return { content: [{ type: "text", text: `Deployed ${version}.` }] };
	},
});

export const approval = actor({
	state: { version: "", approved: false },
	actions: {
		request: (c, version: string) => {
			c.state.version = version;
		},
		approve: (c) => {
			c.state.approved = true;
		},
		consume: (c, version: string) => {
			const approved = c.state.approved && c.state.version === version;
			c.state.approved = false;
			return approved;
		},
	},
});

const client = createClient<Registry<{ approval: typeof approval }>>();
