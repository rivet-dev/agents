import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { dockerProvider } from "@rivet-dev/sandbox-adapter/docker";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in a local Docker container
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: dockerProvider({ image: "ubuntu:24.04" }),
});

export const registry = setup({ use: { agent } });

registry.start();
