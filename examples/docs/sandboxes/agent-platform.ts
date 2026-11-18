import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { agentPlatformProvider } from "@rivet-dev/sandbox-adapter/agent-platform";
import { setup } from "rivetkit";

// read, write, edit, and bash, running in the sandbox
const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: agentPlatformProvider({
		// The shell sandbox template from the setup below.
		template:
			"projects/my-project/locations/us-central1/reasoningEngines/ENGINE_ID/sandboxEnvironmentTemplates/TEMPLATE_ID",
		// The sandbox and its files are deleted after a day.
		create: { ttl: "86400s" },
	}),
});

export const registry = setup({ use: { agent } });

registry.start();
