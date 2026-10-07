import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const anthropicKey = process.env.MY_ANTHROPIC_KEY;
if (!anthropicKey) throw new Error("MY_ANTHROPIC_KEY is not set.");

const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
	apiKeys: { anthropic: anthropicKey },
});

export const registry = setup({ use: { agent } });

registry.start();
