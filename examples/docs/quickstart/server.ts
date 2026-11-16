import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	// read, write, and edit. With no sandbox, the files live in the Actor's own database.
	codingTools: ["read", "write", "edit"],
});

export const registry = setup({ use: { agent } });

registry.start();
