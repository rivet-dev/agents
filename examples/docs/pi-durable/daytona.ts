import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { piDurable } from "@rivet-dev/pi/durable";
import { daytonaProvider } from "@rivet-dev/sandbox-adapter/daytona";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = piDurable({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: daytonaProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();
