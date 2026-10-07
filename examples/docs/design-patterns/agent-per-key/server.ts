import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

// The chat agents have no tools. The issue fixer gets read, write, edit, and bash in a sandbox.
const noTools = createRegistry();
const codingTools = createRegistry();
codingTools.install(CodingTools);

const assistant = pi({ model: "anthropic/claude-opus-5-5", registry: noTools });

const slackThread = pi({ model: "anthropic/claude-haiku-4-5", registry: noTools });

const issueFixer = pi({
	model: "anthropic/claude-opus-5-5",
	registry: codingTools,
	sandbox: e2bProvider(),
	actions: {
		finish: (c) => c.destroy(),
	},
});

export const registry = setup({ use: { assistant, slackThread, issueFixer } });

registry.start();
