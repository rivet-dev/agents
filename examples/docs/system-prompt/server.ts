import { posix } from "node:path";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(
	defineExtension({
		name: "payments-team",
		sections: [
			section("role", () => "You review pull requests for the payments team. Be brief and cite file paths."),
			// Rendered again before every model call, so the date stays current.
			section("date", () => `Today is ${new Date().toDateString()}.`),
			// Read from the conversation's workspace, so an edit to AGENTS.md applies from the next model call.
			section("agents_md", async (input, context) => {
				if (!input.env) return undefined;
				const file = await input.env.readTextFile(posix.join(input.env.cwd, "AGENTS.md"), context);
				if (file.ok) return file.value;
				// No AGENTS.md: leave the section out.
				if (file.error.code === "not_found") return undefined;
				// Any other failure keeps the text the model already has.
				throw file.error;
			}),
		],
	}),
);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
});

export const registry = setup({ use: { agent } });

registry.start();
