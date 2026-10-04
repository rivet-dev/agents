import { pi } from "@rivet-dev/pi";
import { daytonaProvider } from "@rivet-dev/sandbox-adapter/daytona";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: daytonaProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();
