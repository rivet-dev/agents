import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
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
	toolCall,
} from "./helpers/mock-model.js";
import { createSleepCounter } from "./helpers/sleeps.js";

/** Resolves when `signal` aborts. Tasks honor it so a closing harness never waits on them. */
function aborted(signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (!signal || signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** Lifecycle facts by actor key, recorded in this process where the actors run. */
const sleeps = createSleepCounter();
const stopping = new Set<string>();
/** What reading `c.pi` gave the app's onDisconnect: "open" or the error message. */
const disconnectOutcomes = new Map<string, string>();
const keyOf = (c: { key: unknown[] }) => JSON.stringify(c.key);

/** When each actor's stop started and when its sandbox was suspended, by actor id, recorded in this process. */
const stopStartedAt = new Map<string, number>();
const suspendedAt = new Map<string, number>();
/** Actors whose sandbox connected, by actor id. A connected sandbox is suspended on sleep. */
const sandboxConnected = new Set<string>();

/** The grace period of the `slowSleeper` actor, whose own onSleep takes most of it. */
const SLOW_SLEEPER_GRACE_MS = 3_000;
const SLOW_SLEEPER_ON_SLEEP_MS = 2_000;

/** The tool of the drain test waits for `release`. Unsafe, so a rerun would show as an interruption. */
let deployRuns = 0;
const release = Promise.withResolvers<void>();
const deployTool = defineTool({
	name: "deploy_tool",
	description: "An unsafe tool that waits",
	parameters: Type.Object({}),
	replay: "unsafe",
	execute: async () => {
		deployRuns += 1;
		await release.promise;
		return { content: [{ type: "text", text: "deployed" }] };
	},
});

/** Actors whose `holdPi` action has read `c.pi`, by key. The action then waits for `holdRelease`. */
const holding = new Set<string>();
const holdRelease = Promise.withResolvers<void>();

/** The tool of the waiting-caller test waits for `shipRelease`. */
let shipRuns = 0;
const shipRelease = Promise.withResolvers<void>();
const shipTool = defineTool({
	name: "ship_tool",
	description: "A tool that waits",
	parameters: Type.Object({}),
	replay: "unsafe",
	execute: async () => {
		shipRuns += 1;
		await shipRelease.promise;
		return { content: [{ type: "text", text: "shipped" }] };
	},
});

/** The tool of the destroy test runs until it is stopped. This process records both. */
const blocking = { started: 0, stopped: 0 };
const blockingTool = defineTool({
	name: "blocking_tool",
	description: "A tool that runs until it is stopped",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async (_args, _api, context) => {
		blocking.started += 1;
		await aborted(context.abortSignal);
		blocking.stopped += 1;
		context.abortSignal?.throwIfAborted();
		return { content: [{ type: "text", text: "stopped" }] };
	},
});

type JobInput = Record<string, never>;
const jobV1 = defineTask<JobInput, { phase: "run" }, string>({
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
const jobV2 = defineTask<
	JobInput,
	{ phase: "run" } | { phase: "finish" },
	string
>({
	name: "app.job",
	version: 2,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (_task, _runtime, context) => aborted(context.abortSignal),
		finish: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: { status: "completed", result: "migrated" },
				}),
				context,
			);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }),
			context,
		);
	},
	migrate: (input) => ({
		input: input as JobInput,
		checkpoint: { phase: "finish" as const },
	}),
});

let mockModel: MockModel;
let workdir: string;
let registry: ReturnType<typeof buildRegistry>;
const migratingJobs = createRegistry();

function buildRegistry(mock: MockModel, root: string) {
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	const lifecycle = {
		onWake: (c: { key: unknown[]; abortSignal: AbortSignal }) => {
			c.abortSignal.addEventListener("abort", () => stopping.add(keyOf(c)), {
				once: true,
			});
		},
		onSleep: (c: { key: unknown[] }) => {
			sleeps.record(c);
		},
	};
	const tools = createRegistry();
	tools.install(
		defineExtension({
			name: "deploy",
			tools: [deployTool, shipTool, blockingTool],
		}),
	);
	const drainer = pi({
		...models,
		...lifecycle,
		registry: tools,
		onDisconnect: (c) => {
			let outcome = "open";
			try {
				void c.pi;
			} catch (error) {
				outcome = (error as Error).message;
			}
			disconnectOutcomes.set(keyOf(c), outcome);
		},
		actions: {
			nap: (c) => {
				c.sleep();
			},
			destroySelf: (c) => {
				c.destroy();
			},
			holdPi: async (c) => {
				await c.pi.root(BACKGROUND_CONTEXT);
				holding.add(keyOf(c));
				await holdRelease.promise;
				return (await c.pi.root(BACKGROUND_CONTEXT)).id;
			},
		},
	});
	const jobActions = {
		nap: (c: { sleep: () => void }) => {
			c.sleep();
		},
		startJob: async (c: {
			pi: import("@earendil-works/pi-durable").Harness;
		}) => {
			await c.pi.root(BACKGROUND_CONTEXT);
			return c.pi.commit(
				(tx) =>
					tx.createTask(
						jobV1,
						{},
						{
							ownership: { kind: "conversation" },
							conversationId: ROOT_CONVERSATION_ID,
						},
					),
				BACKGROUND_CONTEXT,
			);
		},
		bumpSchema: async (c: {
			db: { execute: (sql: string) => Promise<unknown> };
		}) => {
			await c.db.execute("UPDATE pi_durable_schema SET version = version + 1");
		},
		// What the earlier session-based pi() stored: its own session table and
		// `pi_sandbox`, and none of this pi()'s tables.
		storeAsSessionActor: async (c: {
			db: { execute: (sql: string) => Promise<unknown> };
		}) => {
			await c.db.execute("DROP TABLE pi_durable_watch");
			await c.db.execute("DROP TABLE pi_durable_schema_version");
			await c.db.execute(
				"CREATE TABLE pi_session (session_id TEXT PRIMARY KEY) STRICT",
			);
			await c.db.execute("INSERT INTO pi_session VALUES ('old-session')");
		},
		storedSessions: (c: {
			db: { execute: (sql: string) => Promise<unknown> };
		}) => c.db.execute("SELECT session_id FROM pi_session"),
	};
	// The job runs until the stop interrupts it, so a short grace period ends the drain.
	const options = { sleepGracePeriod: 1_000 };
	const migrating = pi({
		...models,
		...lifecycle,
		options,
		registry: migratingJobs,
		actions: jobActions,
	});
	const coding = createRegistry();
	coding.install(CodingTools);
	const slowSleeper = pi({
		...models,
		registry: coding,
		sandbox: recordingSuspend(localSandboxProvider(join(root, "sandboxes"))),
		options: { sleepGracePeriod: SLOW_SLEEPER_GRACE_MS },
		onWake: (c) => {
			c.abortSignal.addEventListener(
				"abort",
				() => stopStartedAt.set(c.actorId, Date.now()),
				{ once: true },
			);
		},
		onSleep: () =>
			new Promise<void>((resolve) =>
				setTimeout(resolve, SLOW_SLEEPER_ON_SLEEP_MS),
			),
		actions: {
			nap: (c) => {
				c.sleep();
			},
		},
	});
	return setup({ use: { drainer, migrating, slowSleeper } });
}

/** Records when each actor's sandbox connects and when it is suspended. */
function recordingSuspend(provider: SandboxProvider): SandboxProvider {
	return {
		...provider,
		connect: async (c, id) => {
			const sandbox = await provider.connect(c, id);
			if (sandbox) sandboxConnected.add(c.actorId);
			return sandbox;
		},
		suspend: async (c) => {
			suspendedAt.set(c.actorId, Date.now());
		},
	};
}

beforeAll(async () => {
	mockModel = createMockModel();
	workdir = await mkdtemp(join(tmpdir(), "rivet-pi-durable-upgrade-"));
	registry = buildRegistry(mockModel, workdir);
	migratingJobs.install(defineExtension({ name: "jobs", tasks: [jobV1] }));
	mockModel.reply(
		"deploy",
		toolCall("deploy_tool", {}),
		fauxAssistantMessage("deployed it"),
	);
	mockModel.reply("follow up", fauxAssistantMessage("followed up"));
	mockModel.reply(
		"ship",
		toolCall("ship_tool", {}),
		fauxAssistantMessage("shipped it"),
	);
	mockModel.reply(
		"run until closed",
		toolCall("bash", { command: "sleep 600" }),
		fauxAssistantMessage("closed"),
	);
	mockModel.reply(
		"wait for the stop",
		toolCall("blocking_tool", {}),
		fauxAssistantMessage("stopped"),
	);
});

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("pi drain and upgrades", () => {
	test("a forced stop lets the run finish, and input sent during the stop is answered once after wake", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["drain", randomUUID()];
		const handle = client.drainer.getOrCreate(key);
		const root = await handle.harness.root();
		const deploy = await handle.conversation.submit(root.id, {
			type: "input",
			content: "deploy",
		});
		// The tool runs in the background after submit returns; its counter lives in this process.
		await vi.waitFor(() => expect(deployRuns).toBe(1));

		await handle.nap();
		// Shutdown starts after the nap action returns; onWake's abort listener records it in this process.
		await vi.waitFor(() =>
			expect(stopping.has(JSON.stringify(key))).toBe(true),
		);
		// The gateway holds input sent during the stop and delivers it to the next generation.
		const followUp = {
			type: "input" as const,
			content: "follow up",
			requestId: "follow-up-1",
		};
		const sentDuringStop = handle.conversation.submit(root.id, followUp);
		release.resolve();
		const first = await sentDuringStop;
		expect(sleeps.count(key)).toBe(1);

		expect(await handle.submission.wait(deploy.id)).toMatchObject({
			status: "done",
		});
		const retry = await handle.conversation.submit(root.id, followUp);
		expect(retry.id).toBe(first.id);
		expect(await handle.submission.wait(first.id)).toMatchObject({
			status: "done",
		});

		expect(deployRuns).toBe(1);
		const { messages } = await handle.conversation.context(root.id);
		expect(
			messages.find((message) => message.role === "toolResult"),
		).toMatchObject({
			isError: false,
			content: [{ type: "text", text: expect.stringContaining("deployed") }],
		});
		const answers = messages.filter(
			(message) =>
				message.role === "assistant" &&
				message.content.some(
					(block) => block.type === "text" && block.text === "followed up",
				),
		);
		expect(answers).toHaveLength(1);
	});

	test("a prompt in flight when a forced stop starts still gets its answer once the drain finishes the run", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["waiting-caller", randomUUID()];
		const handle = client.drainer.getOrCreate(key);
		const answer = handle.prompt("ship");
		// The tool runs in the background of the prompt action; its counter lives in this process.
		await vi.waitFor(() => expect(shipRuns).toBe(1));

		await handle.nap();
		// Shutdown starts after the nap action returns; onWake's abort listener records it in this process.
		await vi.waitFor(() =>
			expect(stopping.has(JSON.stringify(key))).toBe(true),
		);
		shipRelease.resolve();
		expect(await answer).toMatchObject({ status: "done", text: "shipped it" });
	});

	test("an app action still using c.pi when a sleep starts finishes before Pi Durable closes", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["holding-caller", randomUUID()];
		const handle = client.drainer.getOrCreate(key);
		const held = handle.holdPi();
		// The action records that it holds c.pi in this process.
		await vi.waitFor(() => expect(holding.has(JSON.stringify(key))).toBe(true));

		await handle.nap();
		await sleeps.waitFor(key, 1);
		holdRelease.resolve();
		expect(await held).toBe(ROOT_CONVERSATION_ID);
	});

	test("a run that outlasts the grace period still lets the sandbox suspend before the grace period ends, even when the app's onSleep is slow", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.slowSleeper.getOrCreate(["slow-sleep", randomUUID()]);
		const root = await handle.harness.root();
		const actorId = await handle.resolve();
		await handle.conversation.submit(root.id, {
			type: "input",
			content: "run until closed",
		});
		// The bash tool connects the sandbox in the background after submit returns; the provider records it in this process.
		await vi.waitFor(() => expect(sandboxConnected.has(actorId)).toBe(true));

		await handle.nap();
		// Suspend runs at the end of onSleep, after the action returns; the provider records it in this process.
		await vi.waitFor(() => expect(suspendedAt.has(actorId)).toBe(true), {
			timeout: 10_000,
		});
		const stopStarted = stopStartedAt.get(actorId);
		const suspended = suspendedAt.get(actorId);
		expect(stopStarted).toBeDefined();
		expect((suspended ?? 0) - (stopStarted ?? 0)).toBeLessThan(
			SLOW_SLEEPER_GRACE_MS,
		);
	});

	test("destroying an actor during a run stops the run without waiting for it", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.drainer.getOrCreate(["destroy", randomUUID()]);
		const root = await handle.harness.root();
		await handle.conversation.submit(root.id, {
			type: "input",
			content: "wait for the stop",
		});
		// The tool runs in the background after submit returns; its counter lives in this process.
		await vi.waitFor(() => expect(blocking.started).toBe(1));

		await handle.destroySelf();
		// The grace period is 15 minutes, so only a destroy that skips the drain stops the tool this soon.
		await vi.waitFor(() => expect(blocking.stopped).toBe(1), {
			timeout: 10_000,
		});
	});

	test("a task stored by version 1 resumes under version 2 through migrate", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["migrate", randomUUID()];
		const handle = client.migrating.getOrCreate(key);
		const taskId = await handle.startJob();
		await handle.nap();
		await sleeps.waitFor(key, 1);

		migratingJobs.install(defineExtension({ name: "jobs", tasks: [jobV2] }));
		const settled = await handle.harness.waitForTask(taskId);
		expect(settled.state.outcome).toEqual({
			status: "completed",
			result: "migrated",
		});
	});

	test("storage written by a newer Pi Durable schema makes Pi's actions fail with an internal error, while the app's own actions and hooks still run", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["rollback", randomUUID()];
		const handle = client.migrating.getOrCreate(key);
		await handle.harness.root();
		await handle.bumpSchema();
		await handle.nap();
		await sleeps.waitFor(key, 1);

		// The caller cannot fix a rollback, so RivetKit hides Pi's message; the actor logs it.
		await expect(handle.harness.inspect()).rejects.toMatchObject({
			group: "rivetkit",
			code: "internal_error",
		});
		await handle.nap();
		await sleeps.waitFor(key, 2);
	});

	test("an actor stored by the earlier session-based pi() starts, and its stored session stays", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["session-actor", randomUUID()];
		const handle = client.migrating.getOrCreate(key);
		await handle.harness.root();
		await handle.storeAsSessionActor();
		await handle.nap();
		await sleeps.waitFor(key, 1);

		await expect(handle.harness.root()).resolves.toEqual({
			id: ROOT_CONVERSATION_ID,
		});
		expect(await handle.storedSessions()).toEqual([
			{ session_id: "old-session" },
		]);
	});

	test("the app's onDisconnect runs after a destroy closed Pi Durable, and only reading c.pi fails", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["closed", randomUUID()];
		const conn = client.drainer.getOrCreate(key).connect();
		await conn.harness.root();

		await client.drainer.getOrCreate(key).destroySelf();
		// Destroy closes Pi Durable, then disconnects the connection; the hook records what c.pi gave in this process.
		await vi.waitFor(() =>
			expect(disconnectOutcomes.get(JSON.stringify(key))).toBe(
				"Pi Durable is closed because the actor was destroyed.",
			),
		);
		await conn.dispose();
	});
});
