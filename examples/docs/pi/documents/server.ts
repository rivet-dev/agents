import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { Chambers } from "./chambers";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	documents: [Chambers],
	actions: {
		solveChamber: async (c, chamber: string) => {
			// root() creates the root conversation on first use.
			const root = await c.pi.root(BACKGROUND_CONTEXT);
			// The change is saved in one commit, with the conversation.
			await c.pi.commit(async (tx) => {
				(await tx.doc(Chambers, root.id)).solved.push(chamber);
			}, BACKGROUND_CONTEXT);
		},
		solvedChambers: async (c) => {
			const root = await c.pi.root(BACKGROUND_CONTEXT);
			const chambers = await c.pi.snapshot(Chambers, root.id, BACKGROUND_CONTEXT);
			return chambers?.solved ?? [];
		},
	},
});

export const registry = setup({ use: { agent } });

registry.start();
