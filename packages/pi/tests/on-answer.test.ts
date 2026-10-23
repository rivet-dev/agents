import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	section,
} from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type PiAnswer, pi } from "../src/index.js";
import {
	createMockModel,
	type MockModel,
	slowly,
	toolCall,
} from "./helpers/mock-model.js";

/** Answers by actor key, recorded in this process where the actors run. */
const answers = new Map<string, PiAnswer[]>();
const failFor = new Set<string>();

let mockModel: MockModel;
let registry: ReturnType<typeof buildRegistry>;

const lookup = defineTool({
	name: "lookup",
	description: "Looks something up.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => ({ content: [{ type: "text", text: "found it" }] }),
});

function buildRegistry(mock: MockModel) {
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	const onAnswer = (c: { key: string[] }, answer: PiAnswer) => {
		const key = c.key.join("/");
		if (failFor.has(key)) throw new Error("delivery failed");
		answers.set(key, [...(answers.get(key) ?? []), answer]);
	};
	const tools = createRegistry();
	tools.install(defineExtension({ name: "tools", tools: [lookup] }));
	const agent = pi({ ...models, registry: tools, onAnswer });
	// An app default selection that leaves the answer extension out by name.
	const selected = createRegistry();
	const app = defineExtension({
		name: "app",
		sections: [section("role", () => "Be brief.")],
	});
	selected.install(app);
	const selectingAgent = pi({
		...models,
		registry: selected,
		settings: { extensions: [app] },
		onAnswer,
	});
	return setup({ use: { agent, selectingAgent } });
}

beforeAll(() => {
	mockModel = createMockModel();
	registry = buildRegistry(mockModel);
	mockModel.reply("hello", fauxAssistantMessage("hi there"));
	mockModel.reply(
		"look it up",
		toolCall("lookup", {}),
		fauxAssistantMessage("here it is"),
	);
	mockModel.reply("slow", slowly(fauxAssistantMessage("word ".repeat(20))));
});

describe("onAnswer", () => {
	test("gets the actor's context and each final answer", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		const agent = client.agent.getOrCreate([key]);

		await agent.prompt("hello");
		await agent.prompt("look it up");

		await vi.waitFor(() => expect(answers.get(key)).toHaveLength(2));
		const [first, second] = answers.get(key) ?? [];
		expect(first?.text).toBe("hi there");
		// The tool-calling response is not a final answer.
		expect(second?.text).toBe("here it is");
		expect(first?.conversationId).toBe(second?.conversationId);
	});

	test("runs with an app default selection", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		await client.selectingAgent.getOrCreate([key]).prompt("hello");
		await vi.waitFor(() =>
			expect(answers.get(key)?.map((a) => a.text)).toEqual(["hi there"]),
		);
	});

	test("a failed delivery leaves the run answered", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		failFor.add(key);
		const result = await client.agent.getOrCreate([key]).prompt("hello");
		expect(result).toMatchObject({ status: "done", text: "hi there" });
	});
});

describe("submit", () => {
	test("returns before the run settles, and onAnswer delivers the answer", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		const agent = client.agent.getOrCreate([key]);

		const { submissionId } = await agent.submit("slow");
		expect(answers.get(key)).toBeUndefined();
		expect(await agent.submission.wait(submissionId)).toMatchObject({
			status: "done",
		});
		await vi.waitFor(() => expect(answers.get(key)).toHaveLength(1));
	});

	test("a repeated requestId submits once", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		const agent = client.agent.getOrCreate([key]);

		const first = await agent.submit("hello", { requestId: "sms-1" });
		const second = await agent.submit("hello", { requestId: "sms-1" });
		expect(second.submissionId).toBe(first.submissionId);
		await agent.submission.wait(first.submissionId);
		await agent.harness.waitForIdle();
		expect(answers.get(key)).toHaveLength(1);
	});
});
