import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { piDurable } from "@rivet-dev/pi/durable";
import { setup } from "rivetkit";

const PAYMENTS_API = "https://api.example.com";

// A durable task. Each phase saves its result before the next one starts,
// so after a crash the task carries on from the phase it reached.
const Charge = defineTask<{ card: string; cents: number }, { phase: "charge" }, string>({
	name: "shop.charge",
	version: 1,
	initial: () => ({ phase: "charge" }),
	phases: {
		charge: async (task, runtime, context) => {
			// The idempotency key makes a rerun after a crash charge the card only once.
			const response = await fetch(`${PAYMENTS_API}/charges`, {
				method: "POST",
				headers: { "idempotency-key": `charge-${task.id}` },
				body: JSON.stringify(task.input),
			});
			const { receipt } = (await response.json()) as { receipt: string };
			await runtime.commit(
				() => ({ status: "terminal", outcome: { status: "completed", result: receipt } }),
				context,
			);
		},
	},
	// Runs when the run is cancelled while the charge is in progress: undo it.
	abort: async (task, runtime, context) => {
		await fetch(`${PAYMENTS_API}/charges/charge-${task.id}/refund`, { method: "POST" });
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

const charge = defineTool({
	name: "charge",
	description: "Charge a card for an order.",
	parameters: Type.Object({ card: Type.String(), cents: Type.Number() }),
	execute: async (args, api, context) => {
		// Owned by this tool call, so cancelling the run aborts the charge too.
		const id = await api.createTask(Charge, args, { ownership: { kind: "task", taskId: api.taskId } }, context);
		const { outcome } = (await api.waitForTask(id, context)).state;
		const text = outcome.status === "completed" ? `Charged. Receipt ${outcome.result}.` : `Charge ${outcome.status}.`;
		return { content: [{ type: "text", text }] };
	},
});

const extensions = createRegistry();
extensions.install(defineExtension({ name: "shop", tools: [charge], tasks: [Charge] }));

const agent = piDurable({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
});

export const registry = setup({ use: { agent } });

registry.start();
