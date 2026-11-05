// Seeds actors on the published @rivet-dev/pi 0.5.5, prints their ids, and hangs
// with work in flight until tests/upgrade-from-published.test.ts kills it.
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";

const models = [
	{
		id: "mock-model",
		name: "mock-model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 4_096,
	},
];
const core = (tokensPerSecond) =>
	createFauxCore({ api: "mock", provider: "mock", models, tokensPerSecond });
const replies = {
	"say hello": [fauxAssistantMessage("hello from 0.5.5"), core(0)],
	flaky: [
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error: Overloaded",
		}),
		core(0),
	],
	"run the tool": [
		fauxAssistantMessage(fauxToolCall("slow_tool", {}), {
			stopReason: "toolUse",
		}),
		core(0),
	],
	"stream a story": [fauxAssistantMessage("word ".repeat(2_000)), core(5)],
};

let toolRunning = false;
const slowTool = defineTool({
	name: "slow_tool",
	description: "A tool that is still running when the process dies",
	parameters: Type.Object({}),
	replay: "safe",
	execute: () => {
		toolRunning = true;
		return new Promise(() => {});
	},
});
const extensions = createRegistry();
extensions.install(defineExtension({ name: "seed", tools: [slowTool] }));

const agent = pi({
	model: "mock/mock-model",
	providers: {
		mock: {
			baseUrl: "http://localhost:0",
			api: "mock",
			models,
			streamSimple: (model, context, options) => {
				const prompt = context.messages.findLast(
					(message) => message.role === "user",
				);
				const [message, faux] = replies[prompt.content[0]?.text ?? prompt.content];
				faux.setResponses([message]);
				return faux.streamSimple(model, context, options);
			},
		},
	},
	apiKeys: { mock: "mock" },
	registry: extensions,
	settings: {
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 5_000 },
	},
});
const registry = setup({ use: { agent } });
const { client } = await setupTest({ onTestFinished() {} }, registry);

async function until(check, what) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const live = async (handle, id) => {
	const conn = handle.connect();
	const { value } = await conn.conversation.watch(id);
	await conn.dispose();
	return value.docs["pi.live"];
};

const finished = client.agent.getOrCreate(["finished"]);
const finishedRoot = await finished.harness.root();
await finished.prompt("say hello");

// Stored by a connection that the crash ends, so the row outlives its connection.
const watching = client.agent.getOrCreate(["finished"]).connect();
await watching.conversation.watchEvents(finishedRoot.id);

const toolCrash = client.agent.getOrCreate(["tool-crash"]);
const toolRoot = await toolCrash.harness.root();
const tool = await toolCrash.conversation.submit(toolRoot.id, {
	type: "input",
	content: "run the tool",
});
await until(() => toolRunning, "the tool to run");

const streamCrash = client.agent.getOrCreate(["stream-crash"]);
const streamRoot = await streamCrash.harness.root();
const stream = await streamCrash.conversation.submit(streamRoot.id, {
	type: "input",
	content: "stream a story",
});
await until(
	async () =>
		(await live(streamCrash, streamRoot.id)).generation?.message?.content?.[0]
			?.text,
	"the partial answer to be stored",
);

const backoff = client.agent.getOrCreate(["backoff"]);
const backoffRoot = await backoff.harness.root();
const retry = await backoff.conversation.submit(backoffRoot.id, {
	type: "input",
	content: "flaky",
});
await until(
	async () => (await live(backoff, backoffRoot.id)).generation?.retry,
	"the retry backoff",
);

console.log(
	`SEEDED ${JSON.stringify({
		tool: { conversationId: toolRoot.id, submissionId: tool.id },
		stream: { conversationId: streamRoot.id, submissionId: stream.id },
		backoff: { conversationId: backoffRoot.id, submissionId: retry.id },
		finished: { conversationId: finishedRoot.id },
	})}`,
);
await new Promise(() => {});
