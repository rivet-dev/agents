import { num, obj, str } from "@earendil-works/pi-schema";
import { pi } from "@rivet-dev/pi";
import { actor, setup } from "rivetkit";

// Another actor the agent's tool calls.
const payments = actor({
	state: { refunded: [] as string[] },
	actions: {
		refund: (c, orderId: string, amount: number) => {
			c.state.refunded.push(`${orderId}: $${amount}`);
			return c.state.refunded.length;
		},
	},
});

// One agent per customer, keyed by their email.
const support = pi({
	model: "anthropic/claude-opus-5-5",
	state: { refundedTotal: 0, frozen: false },
	tools: {
		refund: {
			description: "Refund an order, in dollars.",
			parameters: obj({ orderId: str(), amount: num() }),
			// `c` is the agent's context: its key, state, vars, and other actors.
			execute: async (c, args) => {
				const [email] = c.key;
				await c.client<typeof registry>().payments.getOrCreate([email]).refund(args.orderId, args.amount);
				c.state.refundedTotal += args.amount;
				return { output: [{ type: "text", text: `Refunded $${args.amount} for ${args.orderId}.` }] };
			},
		},
	},
	hooks: {
		// Hooks get the agent's context first too.
		beforeTool: (c, call) => (c.state.frozen && call.name === "refund" ? { block: "Refunds are frozen for this customer." } : undefined),
	},
	actions: {
		freezeRefunds: (c) => {
			c.state.frozen = true;
		},
	},
});

export const registry = setup({ use: { support, payments } });

registry.start();
