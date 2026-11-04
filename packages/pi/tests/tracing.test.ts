import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import {
	createMockModel,
	type MockModel,
	toolCall,
} from "./helpers/mock-model.js";
import {
	type CollectedSpan,
	exportTracesTo,
	type OtlpCollector,
	startOtlpCollector,
} from "./helpers/otlp-collector.js";
import { readPiTables } from "./helpers/pi-tables.js";
import { createSleepCounter } from "./helpers/sleeps.js";

const CANARY = "canary-3f1a9c";
const ERROR_STATUS = 2;
const OVERLAPPING_RUNS = 3;

let collector: OtlpCollector;
let sdk: NodeSDK;
let mock: MockModel;
let registry: ReturnType<typeof buildRegistry>;

const sleeps = createSleepCounter();
/** Each tool call of the overlap test waits here until every run has started its own. */
const overlap = {
	arrived: 0,
	everyone: Promise.withResolvers<void>(),
};

function buildRegistry() {
	const tools = createRegistry();
	tools.install(
		defineExtension({
			name: "tools",
			tools: [
				defineTool({
					name: "lookup",
					description: "Looks something up in an app span",
					parameters: obj({ who: str() }),
					execute: async ({ who }) => {
						await trace
							.getTracer("app")
							.startActiveSpan("app.lookup", async (span) => {
								span.setAttribute("who", who);
								if (who !== "alone" && ++overlap.arrived === OVERLAPPING_RUNS) {
									overlap.everyone.resolve();
								}
								if (who !== "alone") await overlap.everyone.promise;
								span.end();
							});
						return { output: [{ type: "text", text: "found" }] };
					},
				}),
				defineTool({
					name: "leak_result",
					description: "Returns the canary",
					parameters: obj({ query: str() }),
					execute: async () => ({
						output: [{ type: "text", text: `result ${CANARY}` }],
					}),
				}),
				defineTool({
					name: "leak_error",
					description: "Throws the canary",
					parameters: obj({ query: str() }),
					execute: async () => {
						throw new Error(`tool failed ${CANARY}`);
					},
				}),
			],
		}),
	);
	const models = {
		model: "mock/mock-model",
		providers: { mock: mock.providerConfig },
		apiKeys: { mock: "mock" },
	};
	const agent = pi({
		...models,
		registry: tools,
		settings: { retry: { baseDelayMs: 10 } },
		actions: {
			actorId: (c) => c.actorId,
			/** The app's own two queries, with a call to Pi between them. */
			appQueries: async (c) => {
				await c.db.execute("CREATE TABLE IF NOT EXISTS app_note (id INTEGER)");
				await c.pi.root(BACKGROUND_CONTEXT);
				await c.db.execute("INSERT INTO app_note VALUES (1)");
			},
			piRows: (c) => readPiTables(c.db),
		},
	});
	const backoff = pi({
		...models,
		registry: createRegistry(),
		// A retry wait past Pi's one-minute threshold, so the actor sleeps through it.
		settings: { retry: { baseDelayMs: 61_000, maxAgentDelayMs: 61_000 } },
		options: { sleepTimeout: 300 },
		onSleep: sleeps.record,
		actions: { actorId: (c) => c.actorId },
	});
	return setup({ use: { agent, backoff } });
}

beforeAll(async () => {
	collector = await startOtlpCollector();
	exportTracesTo(collector);
	// The step Rivet's docs give for application spans.
	sdk = new NodeSDK();
	sdk.start();

	mock = createMockModel();
	registry = buildRegistry();

	const overloaded = fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "503 overloaded",
	});
	mock.reply(
		"use the tool",
		toolCall("lookup", { who: "alone" }),
		fauxAssistantMessage("done"),
	);
	mock.reply(
		"fail at the model",
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "400 credit balance is too low",
		}),
	);
	mock.reply(
		"answer despite overload",
		overloaded,
		fauxAssistantMessage("recovered"),
	);
	mock.reply(
		"flaky across a sleep",
		overloaded,
		fauxAssistantMessage("recovered"),
	);
	mock.reply(
		`secret prompt ${CANARY}`,
		toolCall("leak_result", { query: CANARY }),
		toolCall("leak_error", { query: CANARY }),
		fauxAssistantMessage(`answer ${CANARY}`),
	);
	mock.reply(
		`secret model failure ${CANARY}`,
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: `400 rejected ${CANARY}`,
		}),
	);
	for (const who of ["first", "second", "third"]) {
		mock.reply(
			`overlap ${who}`,
			toolCall("lookup", { who }),
			fauxAssistantMessage("done"),
		);
	}
});

afterAll(async () => {
	await sdk?.shutdown();
	await collector?.close();
});

/** The one span that matches, once its export has arrived. */
async function oneSpan(
	match: (span: CollectedSpan) => boolean,
): Promise<CollectedSpan> {
	return vi.waitFor(() => {
		const found = collector.spans().filter(match);
		expect(found).toHaveLength(1);
		return found[0] as CollectedSpan;
	});
}

function spansOfTrace(traceId: string): CollectedSpan[] {
	return collector.spans().filter((span) => span.traceId === traceId);
}

function spansOfActor(actorId: string): CollectedSpan[] {
	return collector
		.spans()
		.filter((span) => span.attributes["rivet.actor.id"] === actorId);
}

function actionSpan(actorId: string, action: string) {
	return oneSpan(
		(span) =>
			span.attributes["rivet.actor.id"] === actorId &&
			span.attributes["rivet.action.name"] === action,
	);
}

function submitSpan(actorId: string) {
	return oneSpan(
		(span) =>
			span.name === "pi.durable.submit" &&
			span.attributes["rivet.actor.id"] === actorId,
	);
}

describe("pi durable tracing", () => {
	test("a prompt with a tool exports its phases as one tree, linked to the caller", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["tree", randomUUID()]);
		const actorId = await handle.actorId();

		await expect(handle.prompt("use the tool")).resolves.toMatchObject({
			status: "done",
		});
		await collector.quiet();

		const caller = await actionSpan(actorId, "prompt");
		const submit = await submitSpan(actorId);
		expect(submit.parentSpanId).toBeUndefined();
		expect(submit.traceId).not.toBe(caller.traceId);
		expect(submit.links).toEqual([
			{ traceId: caller.traceId, spanId: caller.spanId },
		]);

		const spans = spansOfTrace(submit.traceId);
		const byId = new Map(spans.map((span) => [span.spanId, span]));
		const generation = spans.filter(
			(span) => span.attributes["task.name"] === "pi.generation",
		);
		expect(generation[0]?.parentSpanId).toBe(submit.spanId);
		for (const span of spans.filter((span) => span.name.startsWith("pi."))) {
			expect(span.attributes["rivet.actor.id"]).toBe(actorId);
			if (span.spanId !== submit.spanId) {
				expect(byId.has(span.parentSpanId ?? "")).toBe(true);
			}
		}

		const toolPhase = spans.find(
			(span) => span.attributes["tool.name"] === "lookup",
		);
		expect(byId.get(toolPhase?.parentSpanId ?? "")?.attributes).toMatchObject({
			"task.name": "pi.generation",
			phase: "request",
		});
		const appSpan = spans.find((span) => span.name === "app.lookup");
		expect(appSpan?.parentSpanId).toBe(toolPhase?.spanId);

		// Pi stored where the run's trace continues, for the tasks that outlive this process.
		expect(await handle.piRows()).toContain("traceparent");
	});

	test("the app's own database calls export spans, and Pi's storage exports none", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["storage", randomUUID()]);
		const actorId = await handle.actorId();

		await handle.prompt("use the tool");
		await handle.appQueries();
		await collector.quiet();

		const app = await actionSpan(actorId, "appQueries");
		const queries = spansOfActor(actorId).filter((span) =>
			span.name.startsWith("rivet.sqlite."),
		);
		expect(queries.map((span) => span.name)).toEqual([
			"rivet.sqlite.execute",
			"rivet.sqlite.execute",
		]);
		for (const query of queries) expect(query.parentSpanId).toBe(app.spanId);
	});

	test("a retry across an actor sleep and wake stays in the run's trace", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["sleeping-retry", randomUUID()];
		const handle = client.backoff.getOrCreate(key);
		const actorId = await handle.actorId();
		const root = await handle.harness.root();
		const requestsBefore = mock.requests.length;

		const submission = await handle.conversation.submit(root.id, {
			type: "input",
			content: "flaky across a sleep",
		});
		await sleeps.waitFor(key, 1);
		// Only the scheduled wake can make the second request: no client calls the actor.
		await vi.waitFor(
			() => expect(mock.requests.length).toBe(requestsBefore + 2),
			{ timeout: 90_000 },
		);
		await expect(handle.submission.wait(submission.id)).resolves.toMatchObject({
			status: "done",
		});
		await collector.quiet();

		const submit = await submitSpan(actorId);
		const phases = spansOfActor(actorId).filter(
			(span) => span.name === "pi.durable.phase",
		);
		expect(phases.filter((phase) => phase.attributes.resumed)).not.toEqual([]);
		expect(
			phases.filter((phase) => phase.attributes.phase === "request"),
		).toHaveLength(2);
		expect(new Set(phases.map((phase) => phase.traceId))).toEqual(
			new Set([submit.traceId]),
		);
	}, 120_000);

	test("overlapping runs of two actors and of two conversations never share spans", async (c) => {
		const { client } = await setupTest(c, registry);
		const shared = client.agent.getOrCreate(["overlap-shared", randomUUID()]);
		const other = client.agent.getOrCreate(["overlap-other", randomUUID()]);
		const [sharedId, otherId] = await Promise.all([
			shared.actorId(),
			other.actorId(),
		]);
		const secondConversation = await shared.harness.createConversation({
			ownership: { kind: "ownerless" },
		});

		await Promise.all([
			shared.prompt("overlap first"),
			shared.prompt("overlap second", {
				conversationId: secondConversation.id,
			}),
			other.prompt("overlap third"),
		]);
		await collector.quiet();

		const expected = { first: sharedId, second: sharedId, third: otherId };
		const traceIds = await Promise.all(
			Object.entries(expected).map(async ([who, actorId]) => {
				const appSpan = await oneSpan(
					(span) => span.name === "app.lookup" && span.attributes.who === who,
				);
				const spans = spansOfTrace(appSpan.traceId);
				const piSpans = spans.filter((span) => span.name.startsWith("pi."));
				expect(
					new Set(piSpans.map((span) => span.attributes["rivet.actor.id"])),
				).toEqual(new Set([actorId]));
				expect(
					spans.filter((span) => span.name === "pi.durable.submit"),
				).toHaveLength(1);
				expect(spans.filter((span) => span.name === "app.lookup")).toHaveLength(
					1,
				);
				expect(
					spans.find((span) => span.spanId === appSpan.parentSpanId)
						?.attributes["tool.name"],
				).toBe("lookup");
				return appSpan.traceId;
			}),
		);
		expect(new Set(traceIds).size).toBe(OVERLAPPING_RUNS);
	});

	test("no prompt, tool argument, tool result, or error text reaches an exported span", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["canary", randomUUID()]);
		const actorId = await handle.actorId();
		const conversation = await handle.harness.createConversation({
			ownership: { kind: "ownerless" },
		});

		await expect(
			handle.prompt(`secret prompt ${CANARY}`),
		).resolves.toMatchObject({ status: "done", text: `answer ${CANARY}` });
		await expect(
			handle.prompt(`secret model failure ${CANARY}`, {
				conversationId: conversation.id,
			}),
		).resolves.toMatchObject({ status: "unanswered" });
		await collector.quiet();

		// The tool's error reached the trace as a failed phase, with only its type.
		const failedTool = await oneSpan(
			(span) =>
				span.attributes["rivet.actor.id"] === actorId &&
				span.attributes["tool.name"] === "leak_error",
		);
		expect(failedTool.statusCode).toBe(ERROR_STATUS);
		expect(failedTool.attributes["error.type"]).toBe("task_failed");
		expect(collector.payloads()).not.toContain(CANARY);
	});
});

describe("pi run span", () => {
	test("a run that fails at the model is a failed run span under the prompt action", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["model-failure", randomUUID()]);
		const actorId = await handle.actorId();

		await expect(handle.prompt("fail at the model")).resolves.toMatchObject({
			status: "unanswered",
		});

		const action = await actionSpan(actorId, "prompt");
		const run = await oneSpan(
			(span) =>
				span.name === "invoke_agent pi" &&
				span.attributes["rivet.actor.id"] === actorId,
		);
		expect(run.statusCode).toBe(ERROR_STATUS);
		expect(run.attributes["error.type"]).toBe("unanswered");
		expect(run.parentSpanId).toBe(action.spanId);
	});

	test("a run whose failed model call Pi retried successfully is not a failed run", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["retried", randomUUID()]);
		const actorId = await handle.actorId();

		await expect(
			handle.prompt("answer despite overload"),
		).resolves.toMatchObject({ status: "done" });

		const run = await oneSpan(
			(span) =>
				span.name === "invoke_agent pi" &&
				span.attributes["rivet.actor.id"] === actorId,
		);
		expect(run.statusCode).not.toBe(ERROR_STATUS);
	});
});
