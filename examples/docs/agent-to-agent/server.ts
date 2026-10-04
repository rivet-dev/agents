import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";
import { coder } from "./coder";

const reviewer = pi({
	model: "openai/gpt-5.5",
	sandbox: e2bProvider(),
	actions: {
		requestReview: async (c, request: string) => {
			await c.schedule.after(0, "prompt", request, { streamingBehavior: "followUp" });
		},
	},
});

export const registry = setup({ use: { coder, reviewer } });

registry.start();
