import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { kosa8Provider } from "@rivet-dev/sandbox-adapter/kosa8";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	// Reads KOSA8_API_KEY. The sandbox sleeps with its memory saved while the Actor sleeps.
	sandbox: kosa8Provider({ create: { image: "node:22", size: "2x4" } }),
});

export const registry = setup({ use: { agent } });

registry.start();
