import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { defineSignal, type TaskId } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { setup, UserError } from "rivetkit";
import { type PiAnswer, pi } from "../../src/index.js";
import { createMockModel, toolCall } from "./mock-model.js";

/** What the CI webhook reports for a build. */
export const CiResult = defineSignal({
	name: "test.ci-result",
	version: 1,
	schema: obj({ status: oneOf(["passed", "failed"]) }),
});

const BUILDS =
	"CREATE TABLE IF NOT EXISTS ci_builds (ref TEXT PRIMARY KEY, task_id INTEGER NOT NULL)";

/**
 * The agent of tests/signals.test.ts and tests/signal-crash.test.ts. Its
 * `run_ci` tool parks on `CiResult` until the app's `ciFinished` action, which
 * a webhook handler would call, signals it. A child process runs it with
 * `inChild`, where the woken tool never returns, so only a later process can
 * finish the run.
 */
export function ciAgent(options: {
	inChild: boolean;
	onSleep?: (c: { key: unknown[] }) => void;
}) {
	/** Answers in this process. */
	const answers: PiAnswer[] = [];

	// The mock counts calls per process, so each process scripts only its own model calls.
	const mock = createMockModel();
	mock.reply(
		"wait for CI on main",
		toolCall("run_ci", { ref: "main" }),
		fauxAssistantMessage("CI finished on main"),
	);
	mock.reply(
		"wait for CI on release",
		options.inChild
			? toolCall("run_ci", { ref: "release" })
			: fauxAssistantMessage("CI finished on release"),
	);

	const agent = pi({
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
		// Sleeps soon after work parks, so a test can wait for the sleep.
		options: { sleepTimeout: 500 },
		onWake: async (c) => {
			await c.db.execute(BUILDS);
		},
		onSleep: (c) => options.onSleep?.(c),
		onAnswer: (_c, answer) => {
			answers.push(answer);
		},
		tools: {
			run_ci: {
				description: "Run CI on a git ref and report the result",
				parameters: obj({ ref: str() }),
				replay: "safe",
				async execute(c, args, api, context) {
					const state = await api.readSignal(CiResult, "done", context);
					if (state?.kind === "value") {
						if (options.inChild) await new Promise(() => {});
						return {
							output: [{ type: "text", text: `CI ${state.value.status}` }],
						};
					}
					await c.db.execute(
						"INSERT INTO ci_builds (ref, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
						args.ref,
						api.taskId,
					);
					return { kind: "sleep", signals: [CiResult.key("done")] };
				},
			},
		},
		actions: {
			/** What the CI webhook handler calls. Returns Pi's answer to the delivery. */
			ciFinished: async (c, ref: string, status: "passed" | "failed") => {
				const [build] = await c.db.execute<{ task_id: number }>(
					"SELECT task_id FROM ci_builds WHERE ref = ?",
					ref,
				);
				if (!build) throw new UserError(`No CI build waits for ${ref}.`);
				return c.pi.signal(
					build.task_id as TaskId,
					CiResult,
					"done",
					{ status },
					BACKGROUND_CONTEXT,
				);
			},
		},
	});
	return { registry: setup({ use: { agent } }), answers };
}
