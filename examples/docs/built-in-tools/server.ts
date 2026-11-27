import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

const writer = pi({
	model: "anthropic/claude-opus-5-5",
	// This agent has no sandbox, so its files live in the Actor's own database.
	// There is no shell, so it gets read, write, and edit without bash.
	codingTools: ["read", "write", "edit"],
});

export const registry = setup({ use: { writer } });

registry.start();
