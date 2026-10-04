import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const agent = pi({
	model: "anthropic/claude-sonnet-5-5",
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
