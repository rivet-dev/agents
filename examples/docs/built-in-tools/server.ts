import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

// This agent has no sandbox, so its files live in the Actor's own database.
// There is no shell, so it gets read, write, and edit without bash.
const extensions = createRegistry();
extensions.install(defineExtension({ name: "files", tools: [createReadTool(), createWriteTool(), createEditTool()] }));

const writer = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
});

export const registry = setup({ use: { writer } });

registry.start();
