import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { boxdProvider } from "@rivet-dev/sandbox-adapter/boxd";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: boxdProvider({
		// Labels each machine with its Actor, so you can find it with `boxd machine list --label`.
		create: (c) => ({ labels: { "rivet-actor-id": c.actorId } }),
	}),
});

export const registry = setup({ use: { agent } });

registry.start();
