import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { type Registry, setup, workflow } from "@rivet-dev/workflows";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
});

type Agents = Registry<{ agent: typeof agent }>;

const flakyTest = workflow({
	state: { report: null as string | null },
	run: async (ctx) => {
		await ctx.step({
			name: "first-run",
			timeout: 10 * 60_000,
			run: async (step) => {
				const fixer = step.client<Agents>().agent.getOrCreate([step.actorId]);
				await fixer.abort();
				await fixer.prompt("Clone https://github.com/acme/app, run its test suite, and note any failing tests.");
			},
		});

		await ctx.sleep("wait-before-rerun", 10 * 60_000);

		await ctx.step({
			name: "second-run",
			timeout: 10 * 60_000,
			run: async (step) => {
				const fixer = step.client<Agents>().agent.getOrCreate([step.actorId]);
				await fixer.abort();
				await fixer.prompt("Run the suite again. Which failures happened both times?");
				step.state.report = (await fixer.getLastAssistantText()) ?? null;
			},
		});
	},
	actions: {
		getReport: (c) => c.state.report,
	},
});

export const registry = setup({ use: { agent, flakyTest } });
