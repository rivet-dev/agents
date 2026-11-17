import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { num, obj, str } from "@earendil-works/pi-schema";
import { actor, setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import { createMockModel, toolCall } from "./helpers/mock-model.js";
import { createSleepCounter } from "./helpers/sleeps.js";

const sleeps = createSleepCounter();

/** What the actor's tools saw, recorded in this process where the actors run. */
type ToolCall = {
	tool: string;
	key: string[];
	generation: string;
	conversationId: ConversationId;
};
const toolCalls: ToolCall[] = [];

/** Runs of `slow_refund` by actor key. The first waits until the stop aborts it; a rerun returns at once. */
const slowRuns = new Map<string, number>();

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

const mock = createMockModel();

/** Another actor, which the agent's tools call through `c.client()`. */
const ledger = actor({
	createVars: () => ({ entries: [] as string[] }),
	actions: {
		record: (c, entry: string) => {
			c.vars.entries.push(entry);
			return c.vars.entries.length;
		},
		entries: (c) => c.vars.entries,
	},
});

const lookup = defineTool({
	name: "lookup",
	description: "A tool from the app's own registry",
	parameters: obj({}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "found" }] }),
});
const extensions = createRegistry();
extensions.install(defineExtension({ name: "app", tools: [lookup] }));

const agent = pi({
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
	// The existing registry API still works next to `tools`.
	registry: extensions,
	// New each actor generation, so a tool can tell a wake from the first run.
	createVars: () => ({
		generation: randomUUID(),
		refunded: 0,
		frozen: false,
		blocked: [] as string[],
	}),
	// A short grace period, so a sleep interrupts a running tool like a crash does.
	options: { sleepGracePeriod: 2_000 },
	onSleep: sleeps.record,
	tools: {
		refund: {
			description: "Refund an order",
			parameters: obj({ orderId: str(), amount: num() }),
			replay: "safe",
			async execute(c, args, api, context) {
				// Throws, and fails the tool, if the tool's context has no open harness.
				await c.pi.root(context);
				toolCalls.push({
					tool: "refund",
					key: c.key,
					generation: c.vars.generation,
					conversationId: api.conversationId,
				});
				c.vars.refunded += args.amount;
				const entries = await c
					.client<any>()
					.ledger.getOrCreate(c.key)
					.record(`refund ${args.orderId} ${args.amount}`);
				return {
					output: [{ type: "text", text: `refunded, ledger has ${entries}` }],
				};
			},
		},
		slow_refund: {
			description: "A refund that waits until the actor stops",
			parameters: obj({ amount: num() }),
			replay: "safe",
			async execute(c, args, api, context) {
				const key = c.key.join("/");
				const run = (slowRuns.get(key) ?? 0) + 1;
				slowRuns.set(key, run);
				toolCalls.push({
					tool: "slow_refund",
					key: c.key,
					generation: c.vars.generation,
					conversationId: api.conversationId,
				});
				if (run === 1) await aborted(context.abortSignal);
				context.abortSignal?.throwIfAborted();
				c.vars.refunded += args.amount;
				return { output: [{ type: "text", text: "refunded slowly" }] };
			},
		},
		delegate: {
			description: "Hands a task to a subagent in its own conversation",
			parameters: obj({ task: str() }),
			replay: "safe",
			async execute(_c, args, api, context) {
				const child = await api.commit(
					(tx) =>
						tx.createConversation({
							ownership: { kind: "task", taskId: api.taskId },
						}),
					context,
				);
				const conversation = await api.conversation(child.id, context);
				if (!conversation) throw new Error("the subagent has no conversation");
				const submission = await conversation.submit(
					{ type: "input", content: args.task },
					context,
				);
				const settled = await submission.wait(context);
				return {
					output: [{ type: "text", text: `subagent ${settled.status}` }],
					details: { conversationId: child.id },
				};
			},
		},
	},
	hooks: {
		beforeTool(c, call) {
			if (!c.vars.frozen) return undefined;
			c.vars.blocked.push(call.name);
			return { block: `refunds are frozen for ${c.key.join("/")}` };
		},
	},
	actions: {
		nap: (c) => {
			c.sleep();
		},
		freeze: (c) => {
			c.vars.frozen = true;
		},
		snapshot: (c) => ({ ...c.vars }),
	},
});
const registry = setup({ use: { agent, ledger } });

beforeAll(() => {
	mock.reply(
		"refund order 11",
		toolCall("refund", { orderId: "11", amount: 5 }),
		fauxAssistantMessage("refunded order 11"),
	);
	mock.reply(
		"refund order 12",
		toolCall("refund", { orderId: "12", amount: 7 }),
		fauxAssistantMessage("refunded order 12"),
	);
	mock.reply(
		"refund order 7",
		toolCall("refund", { orderId: "7", amount: 5 }),
		fauxAssistantMessage("refunded order 7"),
	);
	mock.reply(
		"refund order 8",
		toolCall("refund", { orderId: "8", amount: 3 }),
		fauxAssistantMessage("tried order 8"),
	);
	mock.reply(
		"refund slowly",
		toolCall("slow_refund", { amount: 4 }),
		fauxAssistantMessage("refunded slowly"),
	);
	mock.reply(
		"ask a subagent",
		toolCall("delegate", { task: "subagent: refund order 9" }),
		fauxAssistantMessage("the subagent is done"),
	);
	mock.reply(
		"subagent: refund order 9",
		toolCall("refund", { orderId: "9", amount: 2 }),
		fauxAssistantMessage("refunded order 9"),
	);
	mock.reply(
		"look it up",
		toolCall("lookup", {}),
		fauxAssistantMessage("found it"),
	);
});

describe("tools defined like actions", () => {
	test("a tool reads the actor's key, writes its vars, and calls another actor", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["refund", randomUUID()];
		const handle = client.agent.getOrCreate(key);

		expect(await handle.prompt("refund order 7")).toMatchObject({
			status: "done",
			text: "refunded order 7",
		});
		const { messages } = await handle.conversation.context(
			(await handle.harness.root()).id,
		);
		expect(
			messages.find((message) => message.role === "toolResult"),
		).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "refunded, ledger has 1" }],
		});
		expect(await client.ledger.getOrCreate(key).entries()).toEqual([
			"refund 7 5",
		]);
		expect(await handle.snapshot()).toMatchObject({ refunded: 5 });
	});

	test("tools of two actors prompted at the same time each see only their own actor", async (c) => {
		const { client } = await setupTest(c, registry);
		const keys = [
			["isolated", randomUUID()],
			["isolated", randomUUID()],
		];
		const [first, second] = keys.map((key) => client.agent.getOrCreate(key));
		const answers = await Promise.all([
			first?.prompt("refund order 11"),
			second?.prompt("refund order 12"),
		]);

		expect(answers).toMatchObject([{ status: "done" }, { status: "done" }]);
		expect(await first?.snapshot()).toMatchObject({ refunded: 5 });
		expect(await second?.snapshot()).toMatchObject({ refunded: 7 });
		expect(await client.ledger.getOrCreate(keys[0]).entries()).toEqual([
			"refund 11 5",
		]);
		expect(await client.ledger.getOrCreate(keys[1]).entries()).toEqual([
			"refund 12 7",
		]);
	});

	test("a hook gets the actor's context and can block a call by its state", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["frozen", randomUUID()];
		const handle = client.agent.getOrCreate(key);
		await handle.freeze();

		expect(await handle.prompt("refund order 8")).toMatchObject({
			status: "done",
		});
		const { messages } = await handle.conversation.context(
			(await handle.harness.root()).id,
		);
		expect(
			messages.find((message) => message.role === "toolResult"),
		).toMatchObject({
			isError: true,
			content: [
				{
					type: "text",
					text: expect.stringContaining(
						`refunds are frozen for ${key.join("/")}`,
					),
				},
			],
		});
		expect(await handle.snapshot()).toMatchObject({
			refunded: 0,
			blocked: ["refund"],
		});
		expect(await client.ledger.getOrCreate(key).entries()).toEqual([]);
	});

	test("a tool interrupted by a sleep reruns by itself on wake, with the new generation's context", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["slow", randomUUID()];
		const handle = client.agent.getOrCreate(key);
		const root = await handle.harness.root();
		const submission = await handle.conversation.submit(root.id, {
			type: "input",
			content: "refund slowly",
		});
		await vi.waitFor(() => expect(slowRuns.get(key.join("/"))).toBe(1));

		await handle.nap();
		await sleeps.waitFor(key, 1);

		// Call nothing: a call would wake the actor and resume the run itself.
		await vi.waitFor(() => expect(slowRuns.get(key.join("/"))).toBe(2), {
			timeout: 45_000,
			interval: 250,
		});
		expect((await handle.submission.wait(submission.id)).status).toBe("done");
		const runs = toolCalls.filter(
			(call) =>
				call.tool === "slow_refund" && call.key.join("/") === key.join("/"),
		);
		expect(runs).toHaveLength(2);
		expect(runs[1]?.generation).not.toBe(runs[0]?.generation);
		expect(await handle.snapshot()).toMatchObject({
			refunded: 4,
			generation: runs[1]?.generation,
		});
	}, 90_000);

	test("a tool in a conversation another tool created gets the same actor's context", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["subagent", randomUUID()];
		const handle = client.agent.getOrCreate(key);
		const root = await handle.harness.root();

		expect(await handle.prompt("ask a subagent")).toMatchObject({
			status: "done",
			text: "the subagent is done",
		});
		const refunds = toolCalls.filter(
			(call) => call.tool === "refund" && call.key.join("/") === key.join("/"),
		);
		expect(refunds).toHaveLength(1);
		expect(refunds[0]?.conversationId).not.toBe(root.id);
		expect(await handle.snapshot()).toMatchObject({ refunded: 2 });
		expect(await client.ledger.getOrCreate(key).entries()).toEqual([
			"refund 9 2",
		]);
	});

	test("tools from the app's registry still run", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["lookup", randomUUID()]);
		expect(await handle.prompt("look it up")).toMatchObject({
			status: "done",
		});
		const { messages } = await handle.conversation.context(
			(await handle.harness.root()).id,
		);
		// The model answers the same whatever the tool returned, so check the tool's own result.
		expect(
			messages.find((message) => message.role === "toolResult"),
		).toMatchObject({
			isError: false,
			content: [{ type: "text", text: "found" }],
		});
	});
});
