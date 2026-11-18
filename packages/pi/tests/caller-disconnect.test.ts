import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import {
	createMockModel,
	type MockModel,
	slowly,
} from "./helpers/mock-model.js";

const STORY = "word ".repeat(60).trim();

/**
 * Sleeps by actor key, and whether the model was still answering when the
 * last one began. Recorded in this process where the actors run.
 */
const sleeps = new Map<string, { count: number; midAnswer: boolean }>();
const countSleep = (c: { key: unknown[] }) => {
	const key = JSON.stringify(c.key);
	sleeps.set(key, {
		count: (sleeps.get(key)?.count ?? 0) + 1,
		midAnswer: mockModel.streaming() > 0,
	});
};

let mockModel: MockModel;
let registry: ReturnType<typeof buildRegistry>;

function buildRegistry(mock: MockModel) {
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	// A short idle timeout: an actor that is not kept awake sleeps well before the story ends.
	const options = { sleepTimeout: 300 };
	const agent = pi({
		...models,
		registry: createRegistry(),
		options,
		onSleep: countSleep,
	});
	return setup({ use: { agent } });
}

beforeAll(() => {
	mockModel = createMockModel();
	registry = buildRegistry(mockModel);
	mockModel.reply("tell a story", slowly(fauxAssistantMessage(STORY)));
});

async function abortWhileTheModelAnswers(
	call: (signal: AbortSignal) => Promise<unknown>,
) {
	const requestsBefore = mockModel.requests.length;
	const controller = new AbortController();
	const pending = call(controller.signal);
	// The model request starts in this process once the action runs.
	await vi.waitFor(() =>
		expect(mockModel.requests.length).toBeGreaterThan(requestsBefore),
	);
	controller.abort();
	await expect(pending).rejects.toThrow();
}

describe("a caller that disconnects", () => {
	test("the run finishes, and the actor sleeps only after it", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = [randomUUID()];
		const handle = client.agent.getOrCreate(key);
		const root = await handle.harness.root();

		await abortWhileTheModelAnswers((signal) =>
			handle.action({ name: "prompt", args: ["tell a story"], signal }),
		);
		// No client calls the actor here, so only finished work lets it reach its idle timeout.
		await vi.waitFor(
			() => expect(sleeps.get(JSON.stringify(key))?.count).toBe(1),
			{ timeout: 20_000 },
		);
		expect(sleeps.get(JSON.stringify(key))?.midAnswer).toBe(false);

		const { messages } = await handle.conversation.context(root.id);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: STORY }],
		});
	});
});
