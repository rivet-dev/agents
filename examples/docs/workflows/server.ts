import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { type Registry, setup, workflow } from "@rivet-dev/workflows";

const extensions = createRegistry();
extensions.install(CodingTools);

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
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
				// A retried attempt sends the same requestId, so it waits for the first attempt's run.
				await fixer.prompt("Clone https://github.com/acme/app, run its test suite, and note any failing tests.", {
					requestId: `${step.actorId}:first-run`,
				});
			},
		});

		await ctx.sleep("wait-before-rerun", 10 * 60_000);

		await ctx.step({
			name: "second-run",
			timeout: 10 * 60_000,
			run: async (step) => {
				const fixer = step.client<Agents>().agent.getOrCreate([step.actorId]);
				const result = await fixer.prompt("Run the suite again. Which failures happened both times?", {
					requestId: `${step.actorId}:second-run`,
				});
				step.state.report = result.status === "done" ? (result.text ?? null) : `Unanswered: ${result.reason}`;
			},
		});
	},
	actions: {
		getReport: (c) => c.state.report,
	},
});

export const registry = setup({ use: { agent, flakyTest } });

registry.start();
