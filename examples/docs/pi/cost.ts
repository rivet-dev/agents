import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	actions: {
		// What this agent has spent on model calls, in dollars, across every conversation.
		cost: async (c) => {
			const { models } = await c.pi.usage(BACKGROUND_CONTEXT);
			return Object.values(models).reduce((total, usage) => total + usage.cost.total, 0);
		},
	},
});

export const registry = setup({ use: { agent } });

registry.start();
