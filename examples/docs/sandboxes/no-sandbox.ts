import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

// read, write, and edit. With no sandbox, the files live in the Actor's own database.
const extensions = createRegistry();
extensions.install(defineExtension({ name: "files", tools: [createReadTool(), createWriteTool(), createEditTool()] }));

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
});

export const registry = setup({ use: { agent } });

registry.start();
