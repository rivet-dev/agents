import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { pi } from "../src/index.js";
import {
	createMockModel,
	type MockModel,
	slowly,
} from "./helpers/mock-model.js";
import {
	type CollectedSpan,
	exportTracesTo,
	type OtlpCollector,
	startOtlpCollector,
} from "./helpers/otlp-collector.js";

const CANARY = "canary-7d2e41";
const ERROR_STATUS = 2;

let collector: OtlpCollector;
let sdk: NodeSDK;
let mock: MockModel;
let registry: ReturnType<typeof buildRegistry>;
const ownFaux = fauxProvider();

/** Answers with fixed usage, because the faux provider reports no cost. */
function pricedMessage(model: Model<Api>): AssistantMessage {
	return {
		...fauxAssistantMessage("priced"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 11,
			output: 7,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 23,
			cost: {
				input: 0.1,
				output: 0.1,
				cacheRead: 0,
				cacheWrite: 0.05,
				total: 0.25,
			},
		},
	};
}

function buildRegistry() {
	const defaultRuntime = {
		model: "mock/mock-model",
		providers: {
			mock: mock.providerConfig,
			priced: {
				baseUrl: "http://localhost:0",
				api: "priced",
				models: [
					{
						id: "priced-model",
						name: "priced-model",
						reasoning: false,
						input: ["text" as const],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: 4_096,
					},
				],
				streamSimple: (model: Model<Api>) => {
					const stream = createAssistantMessageEventStream();
					const message = pricedMessage(model);
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
					return stream;
				},
			},
		},
		apiKeys: { mock: "mock", priced: "priced" },
		registry: createRegistry(),
		actions: { actorId: (c: { actorId: string }) => c.actorId },
	};
	const agent = pi({
		...defaultRuntime,
		// Small enough that compaction has older entries to summarize.
		settings: {
			retry: { baseDelayMs: 10 },
			compaction: { keepRecentTokens: 1 },
		},
	});
	const priced = pi({ ...defaultRuntime, model: "priced/priced-model" });

	const ownModels = createModels();
	ownModels.setProvider(ownFaux.provider);
	const ownModel = ownFaux.getModel();
	const bringsModels = pi({
		model: `${ownModel.provider}/${ownModel.id}`,
		models: ownModels,
		apiKeys: {},
		registry: createRegistry(),
		actions: { actorId: (c) => c.actorId },
	});
	return setup({ use: { agent, priced, bringsModels } });
}

beforeAll(async () => {
	collector = await startOtlpCollector();
	exportTracesTo(collector);
	sdk = new NodeSDK();
	sdk.start();

	mock = createMockModel();
	registry = buildRegistry();

	mock.reply(
		"answer despite overload",
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: `503 overloaded ${CANARY}`,
		}),
		fauxAssistantMessage(`recovered ${CANARY}`),
	);
	mock.reply(
		"answer later",
		fauxAssistantMessage("", {
			stopReason: "deferred",
			deferred: {
				provider: "mock",
				modelId: "mock-model",
				api: "mock",
				id: "response-1",
				pollAfterMs: 10,
			},
		}),
	);
	mock.reply("slow first", slowly(fauxAssistantMessage("a slow answer")));
	mock.reply("slow second", slowly(fauxAssistantMessage("a slow answer")));
});

afterAll(async () => {
	await sdk?.shutdown();
	await collector?.close();
});

function spansOfActor(actorId: string): CollectedSpan[] {
	return collector
		.spans()
		.filter((span) => span.attributes["rivet.actor.id"] === actorId);
}

function modelSpans(actorId: string): CollectedSpan[] {
	return spansOfActor(actorId).filter((span) => span.name.startsWith("chat "));
}

function phasesOf(actorId: string, phase: string): CollectedSpan[] {
	return spansOfActor(actorId).filter(
		(span) => span.attributes.phase === phase,
	);
}

describe("model request spans", () => {
	// If this fails with two spans per call, Pi's `ModelRuntime` now traces its own
	// calls. Delete `traceModelRequests`: users see the same spans without it.
	test("each attempt of a retried model call has exactly one span under its phase, and the failed one records its type without its text", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["retried", randomUUID()]);
		const actorId = await handle.actorId();
		const requestsBefore = mock.requests.length;

		await expect(
			handle.prompt("answer despite overload"),
		).resolves.toMatchObject({ status: "done", text: `recovered ${CANARY}` });
		await collector.quiet();

		expect(mock.requests.length).toBe(requestsBefore + 2);
		const spans = modelSpans(actorId);
		expect(spans.map((span) => span.name)).toEqual([
			"chat mock-model",
			"chat mock-model",
		]);
		const byId = new Map(
			spansOfActor(actorId).map((span) => [span.spanId, span]),
		);
		for (const span of spans) {
			expect(span.attributes).toMatchObject({
				"gen_ai.operation.name": "chat",
				"gen_ai.provider.name": "mock",
				"gen_ai.request.model": "mock-model",
				"rivet.actor.id": actorId,
			});
			expect(byId.get(span.parentSpanId ?? "")?.attributes).toMatchObject({
				"task.name": "pi.generation",
				phase: "request",
			});
		}
		const failed = spans.filter((span) => span.statusCode === ERROR_STATUS);
		expect(failed.map((span) => span.attributes["error.type"])).toEqual([
			"provider_error",
		]);
		expect(collector.payloads()).not.toContain(CANARY);
	});

	test("a model span reports the call's tokens and cost", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.priced.getOrCreate(["usage", randomUUID()]);
		const actorId = await handle.actorId();

		await expect(handle.prompt("how much")).resolves.toMatchObject({
			text: "priced",
		});
		await collector.quiet();

		expect(modelSpans(actorId).map((span) => span.attributes)).toEqual([
			expect.objectContaining({
				"gen_ai.usage.input_tokens": 16,
				"gen_ai.usage.output_tokens": 7,
				"gen_ai.usage.cost_usd": 0.25,
			}),
		]);
	});

	test("a summary model call has one span under the compaction's phase", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["compact", randomUUID()]);
		const actorId = await handle.actorId();
		const root = await handle.harness.root();
		await handle.prompt("slow first");
		await handle.prompt("slow second");

		await handle.conversation.compact(root.id);
		// The mock has no reply for the summary prompt, so that call fails. It is still one call.
		await vi.waitFor(() =>
			expect(phasesOf(actorId, "summarize")).not.toEqual([]),
		);
		await collector.quiet();

		const [summarize] = phasesOf(actorId, "summarize");
		expect(
			modelSpans(actorId)
				.filter((span) => span.parentSpanId === summarize?.spanId)
				.map((span) => span.name),
		).toEqual(["chat mock-model"]);
	});

	test("a deferred model call has one span under its request phase and one under its poll", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["deferred", randomUUID()]);
		const actorId = await handle.actorId();

		// `pi({ providers })` has no way to fetch a deferred answer, so the poll fails. It is still one call.
		await expect(handle.prompt("answer later")).resolves.toMatchObject({
			status: "unanswered",
		});
		await collector.quiet();

		const [request] = phasesOf(actorId, "request");
		const [poll] = phasesOf(actorId, "poll");
		const spans = modelSpans(actorId);
		const requested = spans.filter(
			(span) => span.parentSpanId === request?.spanId,
		);
		expect(requested).toHaveLength(1);
		// A deferred response has no usage yet, so it reports none rather than zero.
		expect(requested[0]?.attributes).not.toHaveProperty(
			"gen_ai.usage.input_tokens",
		);
		expect(
			spans
				.filter((span) => span.parentSpanId === poll?.spanId)
				.map((span) => span.statusCode),
		).toEqual([ERROR_STATUS]);
		expect(spans).toHaveLength(2);
	});

	test("overlapping model calls of two conversations each sit in their own run's trace", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["overlap", randomUUID()]);
		const actorId = await handle.actorId();
		const other = await handle.harness.createConversation({
			ownership: { kind: "ownerless" },
		});

		const runs = Promise.all([
			handle.prompt("slow first"),
			handle.prompt("slow second", { conversationId: other.id }),
		]);
		await vi.waitFor(() => expect(mock.streaming()).toBe(2));
		await runs;
		await collector.quiet();

		const spans = modelSpans(actorId);
		expect(spans).toHaveLength(2);
		const traces = spans.map((span) => span.traceId);
		expect(new Set(traces).size).toBe(2);
		for (const traceId of traces) {
			expect(
				collector
					.spans()
					.filter(
						(span) =>
							span.traceId === traceId && span.name === "pi.durable.submit",
					),
			).toHaveLength(1);
		}
	});

	test("an app's own models get the same model span, exactly once", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.bringsModels.getOrCreate(["own", randomUUID()]);
		const actorId = await handle.actorId();
		const { provider, id } = ownFaux.getModel();
		ownFaux.setResponses([fauxAssistantMessage("from your models")]);

		await expect(handle.prompt("hello")).resolves.toMatchObject({
			text: "from your models",
		});
		await collector.quiet();

		const spans = modelSpans(actorId);
		expect(spans.map((span) => span.name)).toEqual([`chat ${id}`]);
		expect(spans[0]?.attributes).toMatchObject({
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": provider,
			"gen_ai.request.model": id,
			"gen_ai.usage.input_tokens": expect.any(Number),
			"gen_ai.usage.output_tokens": expect.any(Number),
		});
		expect(spans[0]?.attributes).not.toHaveProperty("usage.input");
		expect(spansOfActor(actorId).map((span) => span.name)).not.toContain(
			"pi.ai.request",
		);
	});

	test("a failed call through an app's own models records its type without its text", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.bringsModels.getOrCreate(["own-fails", randomUUID()]);
		const actorId = await handle.actorId();
		ownFaux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: `400 rejected ${CANARY}`,
			}),
		]);

		await expect(handle.prompt("hello")).resolves.toMatchObject({
			status: "unanswered",
		});
		await collector.quiet();

		const [span] = modelSpans(actorId);
		expect(span?.statusCode).toBe(ERROR_STATUS);
		expect(span?.attributes["error.type"]).toBe("provider_error");
		expect(collector.payloads()).not.toContain(CANARY);
	});
});
