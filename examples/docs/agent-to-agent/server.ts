import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";
import { coder } from "./coder";

const extensions = createRegistry();
extensions.install(CodingTools);

const reviewer = pi({
	model: "openai/gpt-5.5",
	registry: extensions,
	sandbox: e2bProvider(),
	actions: {
		// Saves the request and returns without waiting for the review.
		requestReview: async (c, request: string) => {
			const conversation = await c.pi.root(BACKGROUND_CONTEXT);
			await conversation.submit({ type: "input", content: request }, BACKGROUND_CONTEXT);
		},
	},
});

export const registry = setup({ use: { coder, reviewer } });

registry.start();
