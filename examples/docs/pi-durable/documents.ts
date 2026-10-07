import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { piDurable } from "@rivet-dev/pi/durable";
import { setup } from "rivetkit";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

const agent = piDurable({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	// Clients can read these by kind with harness.snapshot and harness.watchDoc.
	documents: [Todos],
	actions: {
		// c.pi is the Actor's Pi Durable Harness.
		addTodo: async (c, item: string) => {
			await c.pi.commit(async (tx) => {
				(await tx.doc(Todos, ROOT_CONVERSATION_ID)).items.push(item);
			}, BACKGROUND_CONTEXT);
		},
	},
});

export const registry = setup({ use: { agent } });

registry.start();
