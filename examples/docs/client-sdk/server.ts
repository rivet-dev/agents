import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();
