import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { SandboxProvider } from "@rivet-dev/sandbox-adapter";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import { localSandboxProvider } from "./helpers/local-sandbox.js";
import {
	createMockModel,
	type MockModel,
	slowly,
	toolCall,
} from "./helpers/mock-model.js";
import { createSleepCounter } from "./helpers/sleeps.js";

/** Resolves when `signal` aborts. Tools and tasks honor it so a closing harness never waits on them. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

const sleeps = createSleepCounter();

const STORY_ONE = "alpha ".repeat(40).trim();
const STORY_TWO = "omega ".repeat(40).trim();

/** A log larger than one read of the database env, so a scan reads it in parts. */
const LOG = Array.from({ length: 20_000 }, (_, i) => `line ${i + 1}`).join(
	"\n",
);

/** Tool calls of the crash test. A tool's first run blocks until the stop aborts it; a rerun returns at once. */
const toolRuns = { safe: 0, unsafe: 0 };

/** Sandboxes the unreachable provider was asked to create. */
let sandboxCreates = 0;

/** When set, the cold-start provider's connect waits on it, as a sandbox that is still starting does. */
let coldStart: (() => Promise<void>) | undefined;

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ items: [] }),
});

const Poison = defineDoc<{ value: string }>({
	kind: "app.poison",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ value: "" }),
});

const JobTask = defineTask<Record<string, never>, { phase: "run" }, null>({
	name: "app.job",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, _runtime, context) => aborted(context.abortSignal),
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		);
	},
});
const jobs = defineExtension({ name: "jobs", tasks: [JobTask] });

let mockModel: MockModel;
let workdir: string;
let registry: ReturnType<typeof buildRegistry>;
const jobsRegistry = createRegistry();

function buildRegistry(mock: MockModel, root: string) {
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	const waitingTool = (name: "safe" | "unsafe", replay: "safe" | "unsafe") =>
		defineTool({
			name: `${name}_tool`,
			description: `A ${replay} tool that waits`,
			parameters: Type.Object({}),
			replay,
			execute: async (_args, _api, context) => {
				toolRuns[name] += 1;
				if (toolRuns[name] === 1) await aborted(context.abortSignal);
				context.abortSignal?.throwIfAborted();
				return { content: [{ type: "text", text: `${name} done` }] };
			},
		});
	const tools = createRegistry();
	tools.install(
		defineExtension({
			name: "tools",
			tools: [waitingTool("safe", "safe"), waitingTool("unsafe", "unsafe")],
		}),
	);

	const agent = pi({
		...models,
		registry: tools,
		documents: [Todos],
		// A short grace period, so a stop interrupts running tools like a crash does.
		options: { sleepGracePeriod: 2_000 },
		onSleep: sleeps.record,
		actions: {
			nap: (c) => {
				c.sleep();
			},
			addTodo: async (c, conversationId: ConversationId, item: string) => {
				const conversation = await c.pi.conversation(
					conversationId,
					BACKGROUND_CONTEXT,
				);
				await conversation!.commit(async (tx) => {
					(await tx.doc(Todos, conversationId)).items.push(item);
				}, BACKGROUND_CONTEXT);
			},
			failCommitsOfPoison: async (c) => {
				await c.db.execute(
					`CREATE TRIGGER IF NOT EXISTS test_fail_poison BEFORE INSERT ON documents
					 WHEN NEW.kind = '"app.poison"' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
				);
			},
			writePoison: async (c) => {
				await c.pi.commit(async (tx) => {
					(await tx.doc(Poison, ROOT_CONVERSATION_ID)).value = "x";
				}, BACKGROUND_CONTEXT);
			},
		},
	});
	const coder = pi({
		...models,
		registry: (() => {
			const coding = createRegistry();
			coding.install(CodingTools);
			return coding;
		})(),
		sandbox: localSandboxProvider(join(root, "sandboxes")),
	});
	const files = pi({
		...models,
		registry: (() => {
			const coding = createRegistry();
			coding.install(CodingTools);
			return coding;
		})(),
		onSleep: sleeps.record,
		actions: {
			nap: (c) => {
				c.sleep();
			},
			// What 0.5.1 stored: `pi_file` with its rows, at schema version 2.
			storeAs051: async (c) => {
				await c.db.execute(
					"UPDATE pi_durable_schema_version SET schema_version = 2",
				);
			},
		},
	});
	const backoff = pi({
		...models,
		registry: createRegistry(),
		// A retry wait just past the one-minute threshold, so the actor sleeps through it.
		settings: { retry: { baseDelayMs: 61_000, maxAgentDelayMs: 61_000 } },
		options: { sleepTimeout: 300 },
		onSleep: sleeps.record,
	});
	// Every schedule write fails, so a long wait cannot get its wake.
	const backoffWithoutSchedules = pi({
		...models,
		registry: createRegistry(),
		settings: { retry: { baseDelayMs: 61_000, maxAgentDelayMs: 61_000 } },
		options: { sleepTimeout: 300, maxSchedules: 0 },
		onSleep: sleeps.record,
	});
	const jobRunner = pi({
		...models,
		registry: jobsRegistry,
		// The job runs until the stop interrupts it, so a short grace period ends the drain.
		options: { sleepTimeout: 300, sleepGracePeriod: 1_000 },
		onSleep: sleeps.record,
		actions: {
			nap: (c) => {
				c.sleep();
			},
			startJob: async (c) => {
				await c.pi.root(BACKGROUND_CONTEXT);
				await c.pi.commit(
					(tx) =>
						tx.createTask(
							JobTask,
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
	// Neither `model` nor `scopedModels`, so clients may not choose a model.
	// A provider that cannot create a sandbox, for an agent whose tools never need one.
	const unreachable: SandboxProvider = {
		name: "unreachable",
		cwd: "/workspace",
		create: async () => {
			sandboxCreates += 1;
			throw new Error("the sandbox provider is down");
		},
		connect: async () => undefined,
	};
	// One sandbox directory whose working directory is known before it connects, like E2B's.
	const coldRoot = join(root, "cold-start");
	const coldSandboxes = localSandboxProvider(coldRoot);
	const coldStarting: SandboxProvider = {
		name: "cold-start",
		cwd: join(coldRoot, "box"),
		create: async () => {
			await mkdir(join(coldRoot, "box"), { recursive: true });
			return "box";
		},
		connect: async (c, id) => {
			await coldStart?.();
			return coldSandboxes.connect(c, id);
		},
	};
	const coldCoder = pi({
		...models,
		registry: (() => {
			const coding = createRegistry();
			coding.install(CodingTools);
			return coding;
		})(),
		sandbox: coldStarting,
	});
	const lookups = createRegistry();
	lookups.install(
		defineExtension({
			name: "lookups",
			tools: [
				defineTool({
					name: "lookup",
					description: "Look up a value",
					parameters: Type.Object({}),
					replay: "safe",
					execute: async () => ({ content: [{ type: "text", text: "42" }] }),
				}),
			],
		}),
	);
	lookups.install(CodingTools);
	const lookupAgent = pi({
		...models,
		registry: lookups,
		sandbox: unreachable,
	});
	const unscoped = pi({
		providers: models.providers,
		apiKeys: models.apiKeys,
		registry: createRegistry(),
	});
	return setup({
		use: {
			agent,
			coder,
			coldCoder,
			files,
			backoff,
			backoffWithoutSchedules,
			jobRunner,
			unscoped,
			lookupAgent,
		},
	});
}

beforeAll(async () => {
	mockModel = createMockModel();
	workdir = await mkdtemp(join(tmpdir(), "rivet-pi-durable-test-"));
	registry = buildRegistry(mockModel, workdir);
	jobsRegistry.install(jobs);

	mockModel.reply("say hello", fauxAssistantMessage("Hi there!"));
	mockModel.reply(
		"take your time",
		slowly(fauxAssistantMessage("word ".repeat(60).trim())),
	);
	mockModel.reply(
		"use both tools",
		fauxAssistantMessage(
			[fauxToolCall("safe_tool", {}), fauxToolCall("unsafe_tool", {})],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("finished"),
	);
	mockModel.reply(
		"look it up",
		toolCall("lookup", {}),
		fauxAssistantMessage("it is 42"),
	);
	mockModel.reply(
		"create hello.txt",
		toolCall("write", {
			path: "hello.txt",
			content: "hi from pi\nline two\nline three\n",
		}),
		fauxAssistantMessage("written"),
	);
	mockModel.reply(
		"read line two of hello.txt",
		toolCall("read", { path: "hello.txt", offset: 2, limit: 1 }),
		fauxAssistantMessage("read it"),
	);
	mockModel.reply(
		"write the log",
		toolCall("write", { path: "logs/app.log", content: LOG }),
		fauxAssistantMessage("written"),
	);
	mockModel.reply(
		"read two lines of the log",
		toolCall("read", { path: "logs/app.log", offset: 15_000, limit: 2 }),
		fauxAssistantMessage("read it"),
	);
	mockModel.reply(
		"list the logs",
		toolCall("bash", { command: "ls logs" }),
		fauxAssistantMessage("tried"),
	);
	mockModel.reply(
		"write outside the sandbox",
		toolCall("write", { path: "../outside.txt", content: "escaped\n" }),
		fauxAssistantMessage("tried"),
	);
	mockModel.reply(
		"print the host key",
		toolCall("bash", { command: 'echo "key=[$PI_TEST_HOST_KEY]"' }),
		fauxAssistantMessage("ran"),
	);
	mockModel.reply("tell story one", slowly(fauxAssistantMessage(STORY_ONE)));
	mockModel.reply("tell story two", slowly(fauxAssistantMessage(STORY_TWO)));
	mockModel.reply(
		"flaky",
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "overloaded_error: Overloaded",
		}),
		fauxAssistantMessage("recovered"),
	);
});

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("pi actor", () => {
	test("a run stopped at the end of the grace period resumes on wake: safe tools rerun, unsafe tools report the interruption", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["crash", randomUUID()];
		const handle = client.agent.getOrCreate(key);
		const root = await handle.harness.root();
		const submission = await handle.conversation.submit(root.id, {
			type: "input",
			content: "use both tools",
		});
		// Tools run in the background after submit returns; their counters live in this process.
		await vi.waitFor(() => expect(toolRuns).toEqual({ safe: 1, unsafe: 1 }));

		await handle.nap();
		await sleeps.waitFor(key, 1);

		const settled = await handle.submission.wait(submission.id);
		expect(settled.status).toBe("done");
		expect(toolRuns).toEqual({ safe: 2, unsafe: 1 });
		const { messages } = await handle.conversation.context(root.id);
		const results = messages.filter((message) => message.role === "toolResult");
		expect(
			results.find((result) => result.toolName === "safe_tool"),
		).toMatchObject({ isError: false });
		expect(
			results.find((result) => result.toolName === "unsafe_tool"),
		).toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("interrupted") }],
		});
		const answers = messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(block) => block.type === "text" && block.text === "finished",
				),
		);
		expect(answers).toHaveLength(1);
	});

	test("an app action writes a document through c.pi, and clients read it by kind after sleep", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["todos", randomUUID()];
		const handle = client.agent.getOrCreate(key);
		const root = await handle.harness.root();

		await handle.addTodo(root.id, "buy milk");
		await handle.nap();
		await sleeps.waitFor(key, 1);

		expect(await handle.harness.snapshot("app.todos", root.id)).toEqual({
			items: ["buy milk"],
		});
		await expect(
			handle.harness.snapshot("app.unknown", root.id),
		).rejects.toMatchObject({
			group: "user",
			message: expect.stringContaining("app.unknown"),
		});
	});

	test("Pi Durable's own errors reach the client with Pi's error name as the code", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["busy", randomUUID()]);
		const root = await handle.harness.root();
		await handle.conversation.submit(root.id, {
			type: "input",
			content: "take your time",
		});

		await expect(
			handle.conversation.submit(root.id, {
				type: "input",
				content: "say hello",
				whenBusy: "reject",
			}),
		).rejects.toMatchObject({ group: "user", code: "ConversationBusy" });
		await handle.conversation.abort(root.id);
	});

	test("a failed commit reopens the harness, and the next prompt is answered", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["poison", randomUUID()]);
		await handle.harness.root();
		await handle.failCommitsOfPoison();

		await expect(handle.writePoison()).rejects.toThrow();
		const result = await handle.prompt("say hello");
		expect(result).toMatchObject({ status: "done", text: "Hi there!" });
	});

	test("two conversations prompted at the same time each get their own answer, and neither transcript holds the other's messages", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["two", randomUUID()]);
		const one = await handle.harness.root();
		const two = await handle.harness.createConversation({
			ownership: { kind: "ownerless" },
		});

		// Both answers stream slowly, so the two runs overlap.
		const [first, second] = await Promise.all([
			handle.prompt("tell story one", { conversationId: one.id }),
			handle.prompt("tell story two", { conversationId: two.id }),
		]);
		expect(first).toMatchObject({ status: "done", text: STORY_ONE });
		expect(second).toMatchObject({ status: "done", text: STORY_TWO });

		const transcript = async (id: ConversationId) =>
			JSON.stringify((await handle.conversation.context(id)).messages);
		const transcriptOne = await transcript(one.id);
		const transcriptTwo = await transcript(two.id);
		expect(transcriptOne).toContain("tell story one");
		expect(transcriptOne).not.toContain("omega");
		expect(transcriptTwo).toContain("tell story two");
		expect(transcriptTwo).not.toContain("alpha");
	});

	test("a client cannot give a conversation a model when the actor allows none", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.unscoped.getOrCreate(["unscoped", randomUUID()]);
		const root = await handle.harness.root();

		await expect(
			handle.conversation.configure(root.id, {
				model: { provider: "mock", modelId: "mock-model-2" },
			}),
		).rejects.toMatchObject({ group: "user", code: "model_not_allowed" });
		expect((await handle.conversation.agent(root.id)).model).toBeUndefined();
	});

	test("a prompt that uses only a custom tool answers without creating the sandbox", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.lookupAgent.getOrCreate([randomUUID()]);
		const before = sandboxCreates;

		expect(await handle.prompt("look it up")).toMatchObject({
			status: "done",
			text: "it is 42",
		});
		expect(sandboxCreates).toBe(before);
	});

	test("Pi's built-in tools write and read files inside the sandbox", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.coder.getOrCreate(["write", randomUUID()]);

		expect(await handle.prompt("create hello.txt")).toMatchObject({
			status: "done",
			text: "written",
		});
		const sandboxes = join(workdir, "sandboxes");
		const contents = await Promise.all(
			(await readdir(sandboxes)).map((id) =>
				readFile(join(sandboxes, id, "hello.txt"), "utf8").catch(
					() => undefined,
				),
			),
		);
		expect(contents).toContain("hi from pi\nline two\nline three\n");

		await handle.prompt("read line two of hello.txt");
		const root = await handle.harness.root();
		const { messages } = await handle.conversation.context(root.id);
		const read = messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "read",
		);
		expect(read).toMatchObject({ isError: false });
		expect(JSON.stringify(read?.content)).toContain("line two");
		expect(JSON.stringify(read?.content)).not.toContain("hi from pi");
	});

	test("a run stopped while its sandbox starts writes nothing once the sandbox is up", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.coldCoder.getOrCreate([randomUUID()]);
		const root = await handle.harness.root();
		const connecting = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		coldStart = () => {
			started.resolve();
			return connecting.promise;
		};
		try {
			const prompt = handle.prompt("create hello.txt");
			await started.promise;
			const stopping = handle.conversation.abort(root.id);
			// The abort waits for the write that holds the connect, so the test polls for Pi's abort mark before the sandbox comes up.
			await vi.waitFor(async () => {
				const { tasks } = await handle.harness.inspect();
				expect(tasks.some((task) => task.record.abortRequested)).toBe(true);
			});
			connecting.resolve();
			await stopping;
			await prompt;
		} finally {
			coldStart = undefined;
		}

		await expect(
			readFile(join(workdir, "cold-start", "box", "hello.txt"), "utf8"),
		).rejects.toThrow();
	});

	test("without a sandbox, files live in the actor's database: they outlast sleep, a ranged read returns its lines, and there is no shell", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["files", randomUUID()];
		const handle = client.files.getOrCreate(key);
		await handle.prompt("write the log");
		await handle.nap();
		await sleeps.waitFor(key, 1);

		await handle.prompt("read two lines of the log");
		await handle.prompt("list the logs");

		const root = await handle.harness.root();
		const { messages } = await handle.conversation.context(root.id);
		const results = messages.filter((message) => message.role === "toolResult");
		const read = results.find((result) => result.toolName === "read");
		expect(read).toMatchObject({ isError: false });
		expect(JSON.stringify(read?.content)).toContain("line 15000\\nline 15001");
		expect(JSON.stringify(read?.content)).not.toContain("line 15002");
		expect(results.find((result) => result.toolName === "bash")).toMatchObject({
			isError: true,
		});
	});

	test("files an agent without a sandbox stored on 0.5.1 stay readable after the upgrade", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["files-051", randomUUID()];
		const handle = client.files.getOrCreate(key);
		await handle.prompt("create hello.txt");
		await handle.storeAs051();
		await handle.nap();
		await sleeps.waitFor(key, 1);

		await handle.prompt("read line two of hello.txt");

		const root = await handle.harness.root();
		const { messages } = await handle.conversation.context(root.id);
		const read = messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "read",
		);
		expect(read).toMatchObject({ isError: false });
		expect(JSON.stringify(read?.content)).toContain("line two");
	});

	test("sandbox tools cannot write outside the sandbox or read the actor host's environment", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.coder.getOrCreate(["escape", randomUUID()]);
		process.env.PI_TEST_HOST_KEY = "host-secret";
		try {
			await handle.prompt("write outside the sandbox");
			await handle.prompt("print the host key");
		} finally {
			delete process.env.PI_TEST_HOST_KEY;
		}

		const root = await handle.harness.root();
		const { messages } = await handle.conversation.context(root.id);
		const results = messages.filter((message) => message.role === "toolResult");
		expect(results.find((result) => result.toolName === "write")).toMatchObject(
			{ isError: true },
		);
		const bash = results.find((result) => result.toolName === "bash");
		expect(JSON.stringify(bash?.content)).toContain("key=[]");
		await expect(
			readFile(join(workdir, "sandboxes", "outside.txt"), "utf8"),
		).rejects.toThrow();
	});

	test("a long retry wait lets the actor sleep, and a scheduled wake finishes the run", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["backoff", randomUUID()];
		const handle = client.backoff.getOrCreate(key);
		const root = await handle.harness.root();
		const requestsBefore = mockModel.requests.length;
		const submission = await handle.conversation.submit(root.id, {
			type: "input",
			content: "flaky",
		});

		await sleeps.waitFor(key, 1);
		// No client calls the actor here: only the scheduled wake can make the retried model request, recorded in this process.
		await vi.waitFor(
			() => expect(mockModel.requests.length).toBe(requestsBefore + 2),
			{ timeout: 90_000 },
		);
		const settled = await handle.submission.wait(submission.id);
		expect(settled.status).toBe("done");
		const { messages } = await handle.conversation.context(root.id);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered" }],
		});
	}, 120_000);

	test("a long retry wait whose wake cannot be scheduled keeps the actor awake until the run finishes", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["backoff-without-schedules", randomUUID()];
		const handle = client.backoffWithoutSchedules.getOrCreate(key);
		const root = await handle.harness.root();
		const requestsBefore = mockModel.requests.length;
		const submission = await handle.conversation.submit(root.id, {
			type: "input",
			content: "flaky",
		});

		// No client calls the actor here, so only an actor that stayed awake makes the retried model request, recorded in this process.
		await vi.waitFor(
			() => expect(mockModel.requests.length).toBe(requestsBefore + 2),
			{ timeout: 90_000 },
		);
		expect(sleeps.count(key)).toBe(0);
		const settled = await handle.submission.wait(submission.id);
		expect(settled.status).toBe("done");
	}, 120_000);

	test("a task whose definition is gone is reported blocked and does not keep the actor awake", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["blocked", randomUUID()];
		const handle = client.jobRunner.getOrCreate(key);
		await handle.startJob();
		await handle.nap();
		await sleeps.waitFor(key, 1);
		jobsRegistry.uninstall(jobs);
		try {
			const inspection = await handle.harness.inspect();
			expect(inspection.tasks).toEqual([
				expect.objectContaining({
					record: expect.objectContaining({ kind: "app.job" }),
					state: { kind: "blocked", reason: "missing_task" },
				}),
			]);
			await sleeps.waitFor(key, 2);
		} finally {
			jobsRegistry.install(jobs);
		}
	});
});
