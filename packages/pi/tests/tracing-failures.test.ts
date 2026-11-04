import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { type Span, type Tracer, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { pi } from "../src/index.js";
import { createMockModel, toolCall } from "./helpers/mock-model.js";
import {
	exportTracesTo,
	startOtlpCollector,
} from "./helpers/otlp-collector.js";

function broken(): never {
	throw new Error("tracer is broken");
}

const throwingTracer = { startSpan: broken, startActiveSpan: broken } as Tracer;

/** Starts spans that report a valid context and throw from every other call. */
const tracerOfThrowingSpans = {
	startSpan: () =>
		new Proxy({} as Span, {
			get: (_target, method) =>
				method === "spanContext"
					? () => ({
							traceId: "0af7651916cd43dd8448eb211c80319c",
							spanId: "b7ad6b7169203331",
							traceFlags: 1,
						})
					: broken,
		}),
	startActiveSpan: broken,
} as Tracer;

function useTracer(tracer: Tracer) {
	trace.disable();
	trace.setGlobalTracerProvider({ getTracer: () => tracer });
}

const lookup = defineTool({
	name: "lookup",
	description: "Looks something up",
	parameters: obj({}),
	execute: async () => ({ output: [{ type: "text", text: "found" }] }),
});
const piRegistry = createRegistry();
piRegistry.install(defineExtension({ name: "tools", tools: [lookup] }));

const mock = createMockModel();
mock.reply(
	"use the tool",
	toolCall("lookup", {}),
	fauxAssistantMessage("done"),
);

const agent = pi({
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
	registry: piRegistry,
});
const registry = setup({ use: { agent } });

let sdk: NodeSDK;

beforeAll(async () => {
	// A collector that has closed, so nothing listens at the endpoint.
	const collector = await startOtlpCollector();
	await collector.close();
	exportTracesTo(collector);
	sdk = new NodeSDK();
	sdk.start();
});

afterAll(() => sdk?.shutdown().catch(() => {}));

test("a run answers when the collector is down", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate(["dead-collector", randomUUID()]);

	await expect(handle.prompt("use the tool")).resolves.toMatchObject({
		status: "done",
		text: "done",
	});
});

test("a run answers when the tracer throws from startSpan", async (c) => {
	useTracer(throwingTracer);
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate(["throwing-tracer", randomUUID()]);

	await expect(handle.prompt("use the tool")).resolves.toMatchObject({
		status: "done",
		text: "done",
	});
});

test("a run answers when every span call throws", async (c) => {
	useTracer(tracerOfThrowingSpans);
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate(["throwing-spans", randomUUID()]);

	await expect(handle.prompt("use the tool")).resolves.toMatchObject({
		status: "done",
		text: "done",
	});
});
