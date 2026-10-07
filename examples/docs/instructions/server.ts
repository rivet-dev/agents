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
			section("project-rules", () => "Run `npm test` before proposing a fix. Never edit files in `migrations/`."),
			// The skill files are in the sandbox. This section tells the model where to find them.
			section("skills", () => "The `skills/` folder has one folder per skill. Read a skill's SKILL.md before you start a task it covers."),
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
