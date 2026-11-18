import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

// read and bash, without the write and edit tools
const extensions = createRegistry();
extensions.install(defineExtension({ name: "review-tools", tools: [createReadTool(), createBashTool()] }));

const reviewer = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
});

export const registry = setup({ use: { reviewer } });

registry.start();
