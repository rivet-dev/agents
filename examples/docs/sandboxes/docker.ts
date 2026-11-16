import { pi } from "@rivet-dev/pi";
import { dockerProvider } from "@rivet-dev/sandbox-adapter/docker";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	// The sandbox brings read, write, edit, and bash, which run in a local Docker container.
	sandbox: dockerProvider({ image: "ubuntu:24.04" }),
});

export const registry = setup({ use: { agent } });

registry.start();
