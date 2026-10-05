import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	defineTool,
} from "@earendil-works/pi-coding-agent";
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

/** About four seconds of tokens from a `slowly` reply, so a stop lands in the middle. */
const STORY = "word ".repeat(100).trim();
/** About two seconds of tokens. */
const SHORT_ANSWER = "word ".repeat(50).trim();

/** Sleeps by actor key, recorded in this process where the actors run. */
const sleeps = new Map<string, number>();
const countSleep = (c: { key: unknown[] }) => {
	const key = JSON.stringify(c.key);
	sleeps.set(key, (sleeps.get(key) ?? 0) + 1);
};
async function waitForSleeps(key: string[], count: number) {
	// Sleep completes after the action that asked for it returns, and onSleep records it in this process.
	await vi.waitFor(
		() =>
			expect(sleeps.get(JSON.stringify(key)) ?? 0).toBeGreaterThanOrEqual(
				count,
			),
		{
			timeout: 20_000,
		},
	);
}

/** The tool of the destroy test runs until it is stopped. This process records both. */
const blocking = { started: 0, stopped: 0 };
const blockingTool = defineTool({
	name: "blocking_tool",
	label: "Blocking tool",
	description: "A tool that runs until it is stopped",
	parameters: Type.Object({}),
	execute: async (_toolCallId, _params, signal) => {
		blocking.started += 1;
		await new Promise<void>((resolve) => {
			if (!signal || signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		blocking.stopped += 1;
		return { content: [{ type: "text", text: "stopped" }], details: undefined };
	},
});

/** The tool of the slow onSleep test runs until the session closes. This process counts its starts. */
let holdingStarts = 0;
const holdingTool = defineTool({
	name: "holding_tool",
	label: "Holding tool",
	description: "A tool that runs until the session closes",
	parameters: Type.Object({}),
	execute: async (_toolCallId, _params, signal) => {
		holdingStarts += 1;
		await new Promise<void>((resolve) => {
			if (!signal || signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return { content: [{ type: "text", text: "closed" }], details: undefined };
	},
});

/** When each actor's stop started and when its sandbox was suspended, by actor id, recorded in this process. */
const stopStartedAt = new Map<string, number>();
const suspendedAt = new Map<string, number>();

/** The grace period of the `slowSleeper` actor, whose own onSleep takes most of it. */
const SLOW_SLEEPER_GRACE_MS = 3_000;
const SLOW_SLEEPER_ON_SLEEP_MS = 2_000;

let mockModel: MockModel;
let workdir: string;
let registry: ReturnType<typeof buildRegistry>;

function buildRegistry(mock: MockModel, root: string) {
	const shared = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
		settings: { retry: { baseDelayMs: 10 } },
		onSleep: countSleep,
		actions: {
			nap: (c: { sleep: () => void }) => {
				c.sleep();
			},
		},
	};
	// A short grace period, so a stop cuts a run off like a crash does.
	const interrupted = pi({ ...shared, options: { sleepGracePeriod: 500 } });
	const drained = pi({
		...shared,
		customTools: [blockingTool],
		actions: {
			...shared.actions,
			destroySelf: (c: { destroy: () => void }) => {
				c.destroy();
			},
		},
	});
	const slowSleeper = pi({
		...shared,
		customTools: [holdingTool],
		sandbox: recordingSuspend(localSandboxProvider(join(root, "sandboxes"))),
		options: { sleepGracePeriod: SLOW_SLEEPER_GRACE_MS },
		onWake: (c: { actorId: string; abortSignal: AbortSignal }) => {
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
	});
	return setup({ use: { interrupted, drained, slowSleeper } });
}

/** Records when each actor's sandbox is suspended. */
function recordingSuspend(provider: SandboxProvider): SandboxProvider {
	return {
		...provider,
		suspend: async (c) => {
			suspendedAt.set(c.actorId, Date.now());
		},
	};
}

beforeAll(async () => {
	mockModel = createMockModel();
	workdir = await mkdtemp(join(tmpdir(), "rivet-pi-resume-"));
	registry = buildRegistry(mockModel, workdir);
	// The stop cuts off the first call. After wake, the model fails once, Pi retries, and the story arrives.
	mockModel.reply(
		"tell a story",
		slowly(fauxAssistantMessage(STORY)),
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "503 overloaded",
		}),
		fauxAssistantMessage(STORY),
	);
	mockModel.reply("and then?", fauxAssistantMessage("the end"));
	mockModel.reply("tell a story to abort", slowly(fauxAssistantMessage(STORY)));
	mockModel.reply("say hello", fauxAssistantMessage("Hi there!"));
	mockModel.reply(
		"answer for two seconds",
		slowly(fauxAssistantMessage(SHORT_ANSWER)),
	);
	mockModel.reply(
		"hold until closed",
		toolCall("holding_tool", {}),
		fauxAssistantMessage("closed"),
	);
	mockModel.reply(
		"wait for the stop",
		toolCall("blocking_tool", {}),
		fauxAssistantMessage("stopped"),
	);
});

/** Starts a prompt and resolves once the model streams its first token. The prompt's own result is ignored. */
async function promptUntilFirstToken(
	handle: { connect: () => unknown },
	text: string,
): Promise<PiConnection> {
	const conn = handle.connect() as PiConnection;
	const events: AgentSessionEvent[] = [];
	conn.on("event", (event) => events.push(event));
	await conn.getSession();
	conn.prompt(text).catch(() => {});
	// The first token arrives as an event while the run streams.
	await vi.waitFor(() =>
		expect(events.some((event) => event.type === "message_update")).toBe(true),
	);
	return conn;
}

type PiConnection = {
	on: (name: "event", callback: (event: AgentSessionEvent) => void) => unknown;
	getSession: () => Promise<unknown>;
	prompt: (text: string) => Promise<void>;
	followUp: (text: string) => Promise<void>;
	abort: () => Promise<void>;
	dispose: () => Promise<void>;
};

function assistantTexts(
	messages: { role: string; stopReason?: string; content?: unknown }[],
) {
	return messages
		.filter((message) => message.role === "assistant")
		.map((message) => ({
			stopReason: message.stopReason,
			text: (message.content as { type: string; text?: string }[])
				.map((part) => (part.type === "text" ? part.text : ""))
				.join(""),
		}));
}

afterAll(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe("pi() drain and resume", () => {
	test("a forced stop lets a run finish when it ends within the grace period", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["drained", randomUUID()];
		const handle = client.drained.getOrCreate(key);
		const conn = await promptUntilFirstToken(handle, "answer for two seconds");
		const requestsBefore = mockModel.requests.length;
		await conn.dispose();

		await handle.nap();
		await waitForSleeps(key, 1);

		expect(assistantTexts(await handle.getMessages())).toEqual([
			{ stopReason: "stop", text: SHORT_ANSWER },
		]);
		// The run finished before the stop, so the wake asked the model nothing.
		expect(mockModel.requests.length).toBe(requestsBefore);
	});

	test("a run that outlasts the grace period still lets the sandbox suspend before the grace period ends, even when the app's onSleep is slow", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.slowSleeper.getOrCreate(["slow-sleep", randomUUID()]);
		const actorId = await handle.resolve();
		const conn = handle.connect();
		// A new session connects the sandbox for its working directory.
		await conn.getSession();
		const startsBefore = holdingStarts;
		conn.prompt("hold until closed").catch(() => {});
		// The tool starts while the prompt runs; it counts its start in this process.
		await vi.waitFor(() => expect(holdingStarts).toBe(startsBefore + 1));

		await handle.nap();
		// Suspend runs at the end of onSleep, after the action returns; the provider records it in this process.
		await vi.waitFor(() => expect(suspendedAt.has(actorId)).toBe(true), {
			timeout: 10_000,
		});
		const stopStarted = stopStartedAt.get(actorId);
		expect(stopStarted).toBeDefined();
		expect((suspendedAt.get(actorId) ?? 0) - (stopStarted ?? 0)).toBeLessThan(
			SLOW_SLEEPER_GRACE_MS,
		);
		await conn.dispose();
	});

	test("destroying an actor during a run stops the run without waiting for it", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.drained.getOrCreate(["destroy", randomUUID()]);
		handle.prompt("wait for the stop").catch(() => {});
		// The tool runs inside the prompt action; its counter lives in this process.
		await vi.waitFor(() => expect(blocking.started).toBe(1));

		await handle.destroySelf();
		// The grace period is 15 minutes, so only a destroy that skips the drain stops the tool this soon.
		await vi.waitFor(() => expect(blocking.stopped).toBe(1), {
			timeout: 10_000,
		});
	});

	test("a run cut off by a stop resumes on wake through Pi's retry, then answers the queued follow-up", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["interrupted", randomUUID()];
		const handle = client.interrupted.getOrCreate(key);
		const conn = await promptUntilFirstToken(handle, "tell a story");
		await conn.followUp("and then?");
		await conn.dispose();

		await handle.nap();
		await waitForSleeps(key, 1);
		// The wake resumes the run in the background; waitForIdle waits for it.
		await handle.waitForIdle();

		expect(
			assistantTexts(await handle.getMessages()).filter(
				(answer) => answer.stopReason === "stop",
			),
		).toEqual([
			{ stopReason: "stop", text: STORY },
			{ stopReason: "stop", text: "the end" },
		]);
	});

	test("a run stopped by Pi's own abort does not resume, and the next message works", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["aborted", randomUUID()];
		const handle = client.interrupted.getOrCreate(key);
		const conn = await promptUntilFirstToken(handle, "tell a story to abort");
		await conn.abort();
		await conn.dispose();

		await handle.nap();
		await waitForSleeps(key, 1);
		const requestsBefore = mockModel.requests.length;
		await handle.prompt("say hello");

		expect(
			assistantTexts(await handle.getMessages()).map(
				({ stopReason }) => stopReason,
			),
		).toEqual(["aborted", "stop"]);
		// Only the new message reached the model.
		expect(mockModel.requests.length).toBe(requestsBefore + 1);
	});
});
