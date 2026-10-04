import { createRivetKit } from "@rivetkit/react";
import { useState } from "react";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const { useActor } = createRivetKit<typeof registry>();
const client = createClient<typeof registry>();

type Pending = { version: string; approvalKey: string[] };

export function ApprovalDialog({ agentKey }: { agentKey: string[] }) {
	const agent = useActor({ name: "agent", key: agentKey });
	const [pending, setPending] = useState<Pending | null>(null);

	agent.useEvent("event", (event) => {
		if (event.type === "tool_execution_end" && event.toolName === "deploy") {
			setPending(event.result.details.approvalKey ? event.result.details : null);
		}
	});

	async function answer(approved: boolean) {
		if (!pending) return;
		if (approved) await client.approval.getOrCreate(pending.approvalKey).approve();
		const text = approved ? `Approved. Deploy ${pending.version}.` : `Rejected. Don't deploy ${pending.version}.`;
		setPending(null);
		await agent.connection?.prompt(text, { streamingBehavior: "followUp" });
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
