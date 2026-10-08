import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type PiDocFrame, type PiEventsFrame, pi } from "../src/index.js";
import {
	createMockModel,
	type MockModel,
	slowly,
	toolCall,
} from "./helpers/mock-model.js";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

const addTodo = defineTool({
	name: "add_todo",
	description: "Add a todo",
	parameters: Type.Object({ item: Type.String() }),
	replay: "safe",
	execute: async ({ item }, api, context) => {
		await api.commit(async (tx) => {
			(await tx.doc(Todos, api.conversationId)).items.push(item);
		}, context);
		return { content: [{ type: "text", text: "added" }] };
	},
});

/** Sleeps by actor key, recorded in this process where the actors run. */
const sleeps = new Map<string, number>();

let mockModel: MockModel;
let registry: ReturnType<typeof buildRegistry>;

function buildRegistry(mock: MockModel) {
	const extensions = createRegistry();
	extensions.install(defineExtension({ name: "todos", tools: [addTodo] }));
	const agent = pi({
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
		registry: extensions,
		documents: [Todos],
		onSleep: (c) => {
			const key = JSON.stringify(c.key);
			sleeps.set(key, (sleeps.get(key) ?? 0) + 1);
		},
		actions: {
			nap: (c) => {
				c.sleep();
			},
			addTodo: async (c, conversationId: ConversationId, item: string) => {
				await c.pi.commit(async (tx) => {
					(await tx.doc(Todos, conversationId)).items.push(item);
				}, BACKGROUND_CONTEXT);
			},
			clearTodos: async (c, conversationId: ConversationId) => {
				await c.pi.commit(
					(tx) => tx.retireDoc(Todos, conversationId),
					BACKGROUND_CONTEXT,
				);
			},
		},
	});
	return setup({ use: { agent } });
}

beforeAll(() => {
	mockModel = createMockModel();
	registry = buildRegistry(mockModel);
	mockModel.reply(
		"tell a story",
		slowly(fauxAssistantMessage("word ".repeat(60).trim())),
	);
	mockModel.reply(
		"add milk",
		toolCall("add_todo", { item: "milk" }),
		fauxAssistantMessage("added milk"),
	);
	mockModel.reply("say hello", fauxAssistantMessage("Hi there!"));
});

/**
 * Frames one connection received, in arrival order. `push` takes `unknown`
 * because RivetKit types `event<T>()` payloads as `unknown` on the client.
 */
function received<T>(): { frames: T[]; push: (frame: unknown) => void } {
	const frames: T[] = [];
	return { frames, push: (frame) => void frames.push(frame as T) };
}

const hasEvent = (received: PiEventsFrame[], type: string) =>
	received.some((frame) => frame.events.some((event) => event.type === type));

describe("pi watches", () => {
	test("connections watching one conversation see the same frames, a late joiner sees the partial answer, and other conversations see none", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["multiplayer", randomUUID()];
		const first = client.agent.getOrCreate(key).connect();
		const second = client.agent.getOrCreate(key).connect();
		const elsewhere = client.agent.getOrCreate(key).connect();
		const { frames: firstFrames, push: onFirst } = received<PiEventsFrame>();
		const { frames: secondFrames, push: onSecond } = received<PiEventsFrame>();
		const { frames: elsewhereFrames, push: onElsewhere } =
			received<PiEventsFrame>();
		first.on("pi.events", onFirst);
		second.on("pi.events", onSecond);
		elsewhere.on("pi.events", onElsewhere);

		const root = await first.harness.root();
		const other = await first.harness.createConversation({
			ownership: { kind: "ownerless" },
		});
		await first.conversation.watchEvents(root.id);
		await second.conversation.watchEvents(root.id);
		await elsewhere.conversation.watchEvents(other.id);

		const submission = await first.conversation.submit(root.id, {
			type: "input",
			content: "tell a story",
		});
		// Frames arrive over the connection while the model streams.
		await vi.waitFor(() =>
			expect(hasEvent(firstFrames, "message_update")).toBe(true),
		);
		const late = client.agent.getOrCreate(key).connect();
		const { snapshot } = await late.conversation.watchEvents(root.id);
		expect(snapshot.generation?.message?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("word"),
			}),
		]);

		expect(await first.submission.wait(submission.id)).toMatchObject({
			status: "done",
		});
		// The last batch can arrive after the wait action returns.
		await vi.waitFor(() => {
			expect(hasEvent(firstFrames, "run_end")).toBe(true);
			expect(hasEvent(secondFrames, "run_end")).toBe(true);
		});
		expect(firstFrames.map((frame) => frame.seq)).toEqual(
			firstFrames.map((_, index) => index + 1),
		);
		expect(secondFrames.map((frame) => frame.events)).toEqual(
			firstFrames.map((frame) => frame.events),
		);
		expect(elsewhereFrames).toEqual([]);
	});

	test("overlapping watch calls on one connection leave one stream, and an unwatch sent with a watch stops it", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["overlap", randomUUID()];
		const conn = client.agent.getOrCreate(key).connect();
		const sentinel = client.agent.getOrCreate(key).connect();
		const { frames, push } = received<PiEventsFrame>();
		const { frames: sentinelFrames, push: onSentinel } =
			received<PiEventsFrame>();
		conn.on("pi.events", push);
		sentinel.on("pi.events", onSentinel);
		const root = await conn.harness.root();

		await Promise.all([
			conn.conversation.watchEvents(root.id),
			conn.conversation.watchEvents(root.id),
		]);
		const first = await conn.conversation.submit(root.id, {
			type: "input",
			content: "say hello",
		});
		await conn.submission.wait(first.id);
		// The last batch can arrive after the wait action returns.
		await vi.waitFor(() => expect(hasEvent(frames, "run_end")).toBe(true));
		expect(frames.map((frame) => frame.seq)).toEqual(
			frames.map((_, index) => index + 1),
		);

		await Promise.all([
			conn.conversation.watchEvents(root.id),
			conn.conversation.unwatchEvents(root.id),
		]);
		frames.length = 0;
		await sentinel.conversation.watchEvents(root.id);
		const second = await conn.conversation.submit(root.id, {
			type: "input",
			content: "say hello",
		});
		await conn.submission.wait(second.id);
		// Frames go out per commit, so once the sentinel has the run's end, a live stream on conn would have sent it too.
		await vi.waitFor(() =>
			expect(hasEvent(sentinelFrames, "run_end")).toBe(true),
		);
		expect(frames).toEqual([]);
	});

	test("a document watched before it exists sends its value when the model creates it and when an app action changes it", async (c) => {
		const { client } = await setupTest(c, registry);
		const conn = client.agent.getOrCreate(["todos", randomUUID()]).connect();
		const { frames: docFrames, push } = received<PiDocFrame>();
		conn.on("pi.doc", push);
		const root = await conn.harness.root();

		expect(await conn.harness.watchDoc("app.todos", root.id)).toEqual({
			value: undefined,
		});
		expect(await conn.prompt("add milk")).toMatchObject({
			status: "done",
			text: "added milk",
		});
		await conn.addTodo(root.id, "eggs");

		// Document frames follow the commits that the prompt and the action made.
		await vi.waitFor(() =>
			expect(docFrames.map(({ seq, value }) => ({ seq, value }))).toEqual([
				{ seq: 1, value: { items: ["milk"] } },
				{ seq: 2, value: { items: ["milk", "eggs"] } },
			]),
		);
		await expect(
			conn.harness.watchDoc("app.unknown", root.id),
		).rejects.toMatchObject({
			group: "user",
			message: expect.stringContaining("app.unknown"),
		});
	});

	test("a watched document that is retired and created again keeps sending frames", async (c) => {
		const { client } = await setupTest(c, registry);
		const conn = client.agent.getOrCreate(["recreate", randomUUID()]).connect();
		const { frames: docFrames, push } = received<PiDocFrame>();
		conn.on("pi.doc", push);
		const root = await conn.harness.root();
		await conn.addTodo(root.id, "milk");

		expect(await conn.harness.watchDoc("app.todos", root.id)).toEqual({
			value: { items: ["milk"] },
		});
		await conn.clearTodos(root.id);
		// The retire frame follows the commit; wait for it so the next write cannot land first.
		await vi.waitFor(() => expect(docFrames).toHaveLength(1));
		await conn.addTodo(root.id, "eggs");

		// Document frames follow the commits that the actions made.
		await vi.waitFor(() =>
			expect(docFrames.map(({ seq, value }) => ({ seq, value }))).toEqual([
				{ seq: 1, value: null },
				{ seq: 2, value: { items: ["eggs"] } },
			]),
		);
	});

	test("a connection that survives sleep gets its watch back with a fresh snapshot", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["reattach", randomUUID()];
		const conn = client.agent.getOrCreate(key).connect();
		const { frames: eventFrames, push } = received<PiEventsFrame>();
		conn.on("pi.events", push);
		const root = await conn.harness.root();
		await conn.conversation.watchEvents(root.id);

		await conn.nap();
		// Sleep completes after the nap action returns, and onSleep records it in this process.
		await vi.waitFor(() =>
			expect(sleeps.get(JSON.stringify(key)) ?? 0).toBe(1),
		);
		expect(await conn.prompt("say hello")).toMatchObject({
			status: "done",
			text: "Hi there!",
		});

		// The reattached watch sends its snapshot when the actor wakes, before the prompt's batches.
		await vi.waitFor(() => expect(hasEvent(eventFrames, "run_end")).toBe(true));
		const reattached = eventFrames.findIndex((frame) => frame.seq === 0);
		expect(eventFrames[reattached]?.events).toEqual([
			expect.objectContaining({ type: "snapshot" }),
		]);
		expect(eventFrames.slice(reattached).map((frame) => frame.seq)).toEqual(
			eventFrames.slice(reattached).map((_, index) => index),
		);
	});
});
