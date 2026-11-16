import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { obj } from "@earendil-works/pi-schema";
import { setup } from "rivetkit";
import { type PiAnswer, pi } from "../../src/index.js";
import { createMockModel, toolCall } from "./mock-model.js";

/**
 * The agent of tests/crash-recovery.test.ts. The child process in
 * `crash-child.ts` runs it until its tool is running, and the test kills that
 * process with its engine. In the child the tool never returns.
 */
export function crashAgent(options: { inChild: boolean }) {
	/** Runs of the tool in this process. */
	const toolRuns: string[] = [];
	/** Answers in this process. */
	const answers: PiAnswer[] = [];

	// The mock counts calls per process, so each process scripts only its own
	// model call: the child calls the tool, and after the crash the answer follows the rerun.
	const mock = createMockModel();
	mock.reply(
		"run the tool",
		options.inChild
			? toolCall("slow_tool", {})
			: fauxAssistantMessage("the tool finished"),
	);

	const agent = pi({
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
		tools: {
			slow_tool: {
				description: "A tool that is still running when the process dies",
				parameters: obj({}),
				replay: "safe",
				execute: async (c) => {
					toolRuns.push(c.key.join("/"));
					if (options.inChild) {
						process.stdout.write("TOOL_RUNNING\n");
						await new Promise(() => {});
					}
					return { output: [{ type: "text", text: "tool output" }] };
				},
			},
		},
		onAnswer: (_c, answer) => {
			answers.push(answer);
		},
	});
	return { registry: setup({ use: { agent } }), toolRuns, answers };
}
