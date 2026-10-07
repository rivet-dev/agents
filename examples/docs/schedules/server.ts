import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-sonnet-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
	onCreate: async (c) => {
		const [repo] = c.key;
		await c.cron.set({
			name: "morning-triage",
			expression: "0 9 * * *",
			action: "prompt",
			args: [`Clone https://github.com/${repo}, run its test suite, and summarize any failures.`],
		});
	},
});

export const registry = setup({ use: { agent } });

registry.start();
