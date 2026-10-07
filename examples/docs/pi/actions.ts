import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	actions: {
		// c.pi is the Actor's Pi AgentSession.
		triage: async (c, issue: string) => {
			await c.pi.prompt(`Triage this issue and suggest a label: ${issue}`);
			return c.pi.getLastAssistantText();
		},
	},
});

export const registry = setup({ use: { agent } });

registry.start();
