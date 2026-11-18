import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { PiViewFrame } from "@rivet-dev/pi";
import { createRivetKit } from "@rivetkit/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const { useActor } = createRivetKit<typeof registry>();
const client = createClient<typeof registry>();

type Pending = { version: string; approvalId: string };

export function ApprovalDialog({ agentKey }: { agentKey: string[] }) {
	const agent = useActor({ name: "agent", key: agentKey });
	const [pending, setPending] = useState<Pending | null>(null);
	const view = useRef<ConversationView | null>(null);
	// Operations that arrive before the watch call returns.
	const early = useRef<Op[]>([]);
	const answered = useRef(new Set<string>());

	// Shows the newest deploy tool result that asks for an approval.
	const check = useCallback((current: ConversationView) => {
		for (const entry of current.entries.toReversed()) {
			const result = entry.model?.[0];
			if (result?.role !== "toolResult" || result.toolName !== "deploy") continue;
			const details = result.details as Partial<Pending> | undefined;
			if (details?.version && details.approvalId && !answered.current.has(details.approvalId)) {
				setPending({ version: details.version, approvalId: details.approvalId });
			}
			return;
		}
	}, []);

	// Watch the root conversation, so this connection receives its pi.view frames.
	useEffect(() => {
		const conn = agent.connection;
		if (!conn) return;
		void conn.harness
			.root()
			.then((root) => conn.conversation.watch(root.id))
			.then(({ value }) => {
				view.current = applyImmutable(value, early.current);
				check(view.current);
			});
	}, [agent.connection, check]);

	agent.useEvent("pi.view", (frame) => {
		// RivetKit types event payloads as unknown, so name the frame's type.
		const { value, ops = [] } = frame as PiViewFrame;
		if (value) view.current = value;
		else if (view.current) view.current = applyImmutable(view.current, ops);
		else early.current.push(...ops);
		if (view.current) check(view.current);
	});

	async function answer(approved: boolean) {
		if (!pending) return;
		answered.current.add(pending.approvalId);
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
