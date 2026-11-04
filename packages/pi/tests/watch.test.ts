import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import { contentText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	type ConversationView,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	type LiveState,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { type PiDocFrame, type PiViewFrame, pi } from "../src/index.js";
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
	checkpointWhen: () => false,
});

const addTodo = defineTool({
	name: "add_todo",
	description: "Add a todo",
	parameters: obj({ item: str() }),
	replay: "safe",
	execute: async ({ item }, api, context) => {
		await api.commit(async (tx) => {
			(await tx.doc(Todos, api.conversationId)).items.push(item);
		}, context);
		return { output: [{ type: "text", text: "added" }] };
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

/** What a client holds: the view `watch` returned with the frames applied. */
function replay(
	start: ConversationView,
	frames: PiViewFrame[],
): ConversationView {
	return frames.reduce(
		(view, frame) => frame.value ?? applyImmutable(view, frame.ops ?? []),
		start,
	);
}

const liveOf = (view: ConversationView) => view.docs["pi.live"] as LiveState;

/** The answers in a view's entries, as text. */
const answers = (view: ConversationView) =>
	view.entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			message.role === "assistant" ? [contentText(message.content, "")] : [],
		),
	);

describe("pi watches", () => {
	test("connections watching one conversation see the same answer, a late joiner sees the partial answer, and other conversations send nothing", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["multiplayer", randomUUID()];
		const first = client.agent.getOrCreate(key).connect();
		const second = client.agent.getOrCreate(key).connect();
		const elsewhere = client.agent.getOrCreate(key).connect();
		const { frames: firstFrames, push: onFirst } = received<PiViewFrame>();
		const { frames: secondFrames, push: onSecond } = received<PiViewFrame>();
		const { frames: elsewhereFrames, push: onElsewhere } =
			received<PiViewFrame>();
		first.on("pi.view", onFirst);
		second.on("pi.view", onSecond);
		elsewhere.on("pi.view", onElsewhere);

		const root = await first.harness.root();
		const other = await first.harness.createConversation({
			ownership: { kind: "ownerless" },
		});
		const firstStart = await first.conversation.watch(root.id);
		const secondStart = await second.conversation.watch(root.id);
		await elsewhere.conversation.watch(other.id);

		const submission = await first.conversation.submit(root.id, {
			type: "input",
			content: "tell a story",
		});
		// Frames arrive over the connection while the model streams.
		await vi.waitFor(() =>
			expect(
				JSON.stringify(
					liveOf(replay(firstStart.value, firstFrames)).generation?.message,
				),
			).toContain("word"),
		);
		const late = client.agent.getOrCreate(key).connect();
		const { value: lateView } = await late.conversation.watch(root.id);
		expect(liveOf(lateView).generation?.message?.content).toEqual([
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("word"),
			}),
		]);

		expect(await first.submission.wait(submission.id)).toMatchObject({
			status: "done",
		});
		const story = "word ".repeat(60).trim();
		// The last frame can arrive after the wait action returns.
		await vi.waitFor(() => {
			expect(answers(replay(firstStart.value, firstFrames))).toEqual([story]);
			expect(answers(replay(secondStart.value, secondFrames))).toEqual([story]);
		});
		expect(firstFrames.map((frame) => frame.seq)).toEqual(
			firstFrames.map((_, index) => index + 1),
		);
		expect(elsewhereFrames).toEqual([]);
	});

	test("a client pages the transcript older than the view's newest entries through conversation.entries", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["long", randomUUID()]);
		const root = await handle.harness.root();
		// A prompt stores two entries: the input and the answer.
		for (let index = 0; index < 30; index += 1) {
			await handle.prompt("say hello");
		}

		const conn = handle.connect();
		const { value } = await conn.conversation.watch(root.id);
		await conn.dispose();
		expect(value.entries).toHaveLength(50);
		expect(value.before).toBeDefined();
		const older = await handle.conversation.entries(
			root.id,
			{ maxEntryId: value.before, order: "ascending" },
			100,
		);
		const whole = await handle.conversation.entries(
			root.id,
			{ order: "ascending" },
			100,
		);
		expect([...older.items, ...value.entries].map((entry) => entry.id)).toEqual(
			whole.items.map((entry) => entry.id),
		);
	});

	test("overlapping watch calls on one connection leave one stream, and an unwatch stops it", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["overlap", randomUUID()];
		const conn = client.agent.getOrCreate(key).connect();
		const sentinel = client.agent.getOrCreate(key).connect();
		const { frames, push } = received<PiViewFrame>();
		const { frames: sentinelFrames, push: onSentinel } =
			received<PiViewFrame>();
		conn.on("pi.view", push);
		sentinel.on("pi.view", onSentinel);
		const root = await conn.harness.root();

		const [{ value: start }] = await Promise.all([
			conn.conversation.watch(root.id),
			conn.conversation.watch(root.id),
		]);
		const first = await conn.conversation.submit(root.id, {
			type: "input",
			content: "say hello",
		});
		await conn.submission.wait(first.id);
		// The last frame can arrive after the wait action returns.
		await vi.waitFor(() =>
			expect(answers(replay(start, frames))).toEqual(["Hi there!"]),
		);
		expect(frames.map((frame) => frame.seq)).toEqual(
			frames.map((_, index) => index + 1),
		);

		// Awaited in turn, because RivetKit can start actions sent together in either order.
		await conn.conversation.watch(root.id);
		await conn.conversation.unwatch(root.id);
		frames.length = 0;
		const { value: sentinelStart } = await sentinel.conversation.watch(root.id);
		const second = await conn.conversation.submit(root.id, {
			type: "input",
			content: "say hello",
		});
		await conn.submission.wait(second.id);
		// Frames go out per commit, so once the sentinel has the answer, a live stream on conn would have sent it too.
		await vi.waitFor(() =>
			expect(answers(replay(sentinelStart, sentinelFrames))).toEqual([
				"Hi there!",
				"Hi there!",
			]),
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

	test("a connection that watches each time it opens gets the next run after sleep closes it", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["rewatch", randomUUID()];
		const conn = client.agent.getOrCreate(key).connect();
		const { frames, push } = received<PiViewFrame>();
		conn.on("pi.view", push);
		const root = await conn.harness.root();
		// Sleep closes the connection, so the client watches again each time it opens.
		const watches: Promise<{ value: ConversationView }>[] = [];
		conn.onOpen(() => {
			watches.push(conn.conversation.watch(root.id));
		});
		// The connection is already open, so onOpen runs in a microtask.
		await vi.waitFor(() => expect(watches).toHaveLength(1));
		await watches[0];

		await conn.nap();
		// The client reconnects on its own after sleep closes the connection, and that wakes the actor.
		await vi.waitFor(() => expect(watches).toHaveLength(2));
		const { value: start } = (await watches[1]) as { value: ConversationView };
		expect(sleeps.get(JSON.stringify(key))).toBe(1);
		const afterWake = frames.length;
		expect(await conn.prompt("say hello")).toMatchObject({
			status: "done",
			text: "Hi there!",
		});

		// The new watch numbers its frames from 1, after the view that watch returned.
		await vi.waitFor(() =>
			expect(answers(replay(start, frames.slice(afterWake)))).toEqual([
				"Hi there!",
			]),
		);
		const numbers = frames.slice(afterWake).map((frame) => frame.seq);
		expect(numbers).toEqual(numbers.map((_, index) => index + 1));
	});
});
