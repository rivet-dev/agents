import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const assistant = pi({ model: "anthropic/claude-opus-5-5" });

const slackThread = pi({ model: "anthropic/claude-haiku-4-5" });

const issueFixer = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
	actions: {
		finish: (c) => c.destroy(),
	},
});

export const registry = setup({ use: { assistant, slackThread, issueFixer } });

registry.start();
