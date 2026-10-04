import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const anthropicKey = process.env.MY_ANTHROPIC_KEY;
if (!anthropicKey) throw new Error("MY_ANTHROPIC_KEY is not set.");

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
	apiKeys: { anthropic: anthropicKey },
});

export const registry = setup({ use: { agent } });

registry.start();
