import { pi } from "@rivet-dev/pi";
import { agentOSProvider } from "@rivet-dev/sandbox-adapter/agentos";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	// The sandbox brings read, write, edit, and bash, which run in it.
	sandbox: agentOSProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();
