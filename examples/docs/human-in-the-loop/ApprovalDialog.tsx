import { createRivetKit } from "@rivetkit/react";
import { useEffect, useState } from "react";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const { useActor } = createRivetKit<typeof registry>();
const client = createClient<typeof registry>();

type Pending = { version: string; approvalId: string };

export function ApprovalDialog({ agentKey }: { agentKey: string[] }) {
	const agent = useActor({ name: "agent", key: agentKey });
	const [pending, setPending] = useState<Pending | null>(null);

	// Watch the root conversation, so this connection receives its pi.events.
	useEffect(() => {
		const conn = agent.connection;
		if (!conn) return;
		void conn.harness.root().then((root) => conn.conversation.watchEvents(root.id));
	}, [agent.connection]);

	agent.useEvent("pi.events", ({ events }) => {
		for (const event of events) {
			if (event.type !== "tool_execution_end" || event.toolName !== "deploy") continue;
			const result = event.entry?.model?.[0];
			if (result?.role !== "toolResult") continue;
			const details = result.details as Partial<Pending> | undefined;
			if (details?.version && details.approvalId) {
				setPending({ version: details.version, approvalId: details.approvalId });
			}
		}
	});

	async function answer(approved: boolean) {
		if (!pending) return;
		if (approved) await client.approval.get([pending.approvalId]).approve();
		const text = approved ? `Approved. Deploy ${pending.version}.` : `Rejected. Don't deploy ${pending.version}.`;
		setPending(null);
		await agent.connection?.prompt(text);
	}

	if (!pending) return null;

	return (
		<div role="alertdialog">
			<p>The agent wants to deploy {pending.version}.</p>
			<button type="button" onClick={() => void answer(true)}>
				Approve
			</button>
			<button type="button" onClick={() => void answer(false)}>
				Reject
			</button>
		</div>
	);
}
