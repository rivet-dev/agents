import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { actor, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";

export const deploy = defineTool({
	name: "deploy",
	label: "Deploy",
	description: "Deploy a version to production. Every deploy needs a person's approval.",
	parameters: Type.Object({ version: Type.String() }),
	async execute(_toolCallId, { version }, signal, _onUpdate, ctx) {
		const approvalKey = [ctx.sessionManager.getSessionId(), version];
		if (!(await client.approval.getOrCreate(approvalKey).consume())) {
			const text = `Waiting for a person to approve deploying ${version}.`;
			return { content: [{ type: "text", text }], details: { version, approvalKey }, terminate: true };
		}
		await fetch(`https://deploy.example.com/releases/${version}`, { method: "POST", signal });
		return { content: [{ type: "text", text: `Deployed ${version}.` }], details: { version } };
	},
});

export const approval = actor({
	state: { approved: false },
	actions: {
		approve: (c) => {
			c.state.approved = true;
		},
		consume: (c) => {
			const approved = c.state.approved;
			c.state.approved = false;
			return approved;
		},
	},
});

const client = createClient<Registry<{ approval: typeof approval }>>();
