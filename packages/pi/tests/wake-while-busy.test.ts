import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTask,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import { createMockModel } from "./helpers/mock-model.js";

const BACKOFF_MS = 2_000;

/** Runs until its actor stops and never commits, so nothing else starts a scheduler pass. */
const StuckTask = defineTask<Record<string, never>, { phase: "run" }, null>({
	name: "app.stuck",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: (_task, _runtime, context) =>
			new Promise<never>((_, reject) => {
				context.abortSignal?.addEventListener(
					"abort",
					() => reject(context.abortSignal?.reason),
					{ once: true },
				);
			}),
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		);
	},
});

const mock = createMockModel();
mock.reply(
	"flaky",
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "overloaded_error: Overloaded",
	}),
	fauxAssistantMessage("recovered"),
);

const piRegistry = createRegistry();
piRegistry.install(defineExtension({ name: "stuck", tasks: [StuckTask] }));

const agent = pi({
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
	registry: piRegistry,
	settings: {
		retry: { enabled: true, maxRetries: 1, baseDelayMs: BACKOFF_MS },
	},
	actions: {
		startStuckTask: async (c) => {
			await c.pi.root(BACKGROUND_CONTEXT);
			await c.pi.commit(
				(tx) =>
					tx.createTask(
						StuckTask,
						{},
						{
							ownership: { kind: "conversation" },
							conversationId: ROOT_CONVERSATION_ID,
						},
					),
				BACKGROUND_CONTEXT,
			);
		},
	},
});
const registry = setup({ use: { agent } });

test("a retry whose backoff ends while another task runs happens on time, with no client call", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate(["busy", randomUUID()]);
	const root = await handle.harness.root();
	await handle.startStuckTask();
	const callsBefore = mock.requests.length;

	const submission = await handle.conversation.submit(root.id, {
		type: "input",
		content: "flaky",
	});

	await vi.waitFor(() => expect(mock.requests.length).toBe(callsBefore + 1), {
		timeout: 10_000,
		interval: 20,
	});
	await vi.waitFor(() => expect(mock.requests.length).toBe(callsBefore + 2), {
		timeout: BACKOFF_MS * 4,
		interval: 50,
	});
	expect((await handle.submission.wait(submission.id)).status).toBe("done");
});
