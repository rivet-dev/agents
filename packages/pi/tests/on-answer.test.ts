import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	type Report,
	section,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
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
/** What the typed agent's onAnswer read from `c.pi` and `c.vars`, by actor key. */
const typedAnswers = new Map<
	string,
	{ rootId: ConversationId; answered: number }
>();
/** What `onReport` received, in this process where the actors run. */
const reports: Report[] = [];

let mockModel: MockModel;
let registry: ReturnType<typeof buildRegistry>;

const lookup = defineTool({
	name: "lookup",
	description: "Looks something up.",
	parameters: obj({}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "found it" }] }),
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
	const agent = pi({
		...models,
		registry: tools,
		onAnswer,
		onReport: (report) => void reports.push(report),
	});
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
	// onAnswer's `c` is typed from the actor, with `c.pi`, so it needs no cast.
	const typedAgent = pi({
		...models,
		registry: tools,
		createVars: () => ({ answered: 0 }),
		onAnswer: async (c, _answer) => {
			c.vars.answered += 1;
			// @ts-expect-error onAnswer's vars are the actor's own
			c.vars.missing;
			const root = await c.pi.root(BACKGROUND_CONTEXT);
			typedAnswers.set(c.key.join("/"), {
				rootId: root.id,
				answered: c.vars.answered,
			});
		},
	});
	return setup({ use: { agent, selectingAgent, typedAgent } });
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

	test("gets c.pi and the actor's typed state", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		const agent = client.typedAgent.getOrCreate([key]);
		const root = await agent.harness.root();

		await agent.prompt("hello");

		await vi.waitFor(() =>
			expect(typedAnswers.get(key)).toEqual({ rootId: root.id, answered: 1 }),
		);
	});

	test("a failed delivery leaves the run answered and reaches onReport", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = randomUUID();
		failFor.add(key);
		const result = await client.agent.getOrCreate([key]).prompt("hello");
		expect(result).toMatchObject({ status: "done", text: "hi there" });
		expect(reports).toContainEqual(
			expect.objectContaining({
				kind: "extension_error",
				error: expect.objectContaining({ message: "delivery failed" }),
			}),
		);
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
