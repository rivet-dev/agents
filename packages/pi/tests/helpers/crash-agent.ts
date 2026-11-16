import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { setup } from "rivetkit";
import { type PiAnswer, pi } from "../../src/index.js";
import { createMockModel, toolCall } from "./mock-model.js";

/**
 * The agent of tests/crash-recovery.test.ts. The child process in
 * `crash-child.ts` runs it until its tool is running, and the test kills that
 * process and its engine. In the child the tool never returns.
 */
export function crashAgent(options: { inChild: boolean }) {
	/** What happened to the actor in this process, in order. */
	const events: ("wake" | "tool" | "answer" | "sleep")[] = [];
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

	const tools = createRegistry();
	tools.install(
		defineExtension({
			name: "crash",
			tools: [
				defineTool({
					name: "slow_tool",
					description: "A tool that is still running when the process dies",
					parameters: obj({}),
					replay: "safe",
					execute: async () => {
						events.push("tool");
						if (options.inChild) {
							process.stdout.write("TOOL_RUNNING\n");
							await new Promise(() => {});
						}
						return { output: [{ type: "text", text: "tool output" }] };
					},
				}),
			],
		}),
	);

	const agent = pi({
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
		registry: tools,
		// Sleeps soon after the run, so a stray wake would show as a new wake.
		options: { sleepTimeout: 500 },
		onWake: () => {
			events.push("wake");
		},
		onSleep: () => {
			events.push("sleep");
		},
		onAnswer: (_c, answer) => {
			events.push("answer");
			answers.push(answer);
		},
	});
	return { registry: setup({ use: { agent } }), events, answers };
}
