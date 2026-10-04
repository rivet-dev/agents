import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const reviewer = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
	excludeTools: ["bash", "edit", "write"],
});

export const registry = setup({ use: { reviewer } });

registry.start();
