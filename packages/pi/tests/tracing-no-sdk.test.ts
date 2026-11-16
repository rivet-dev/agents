import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, expect, test } from "vitest";
import { pi } from "../src/index.js";
import { createMockModel } from "./helpers/mock-model.js";
import {
	exportTracesTo,
	type OtlpCollector,
	startOtlpCollector,
} from "./helpers/otlp-collector.js";

// This file registers no OpenTelemetry SDK. Only the environment variables are set.
const mock = createMockModel();
mock.reply("hello", fauxAssistantMessage("hi"));

const agent = pi({
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
	registry: createRegistry(),
});
const registry = setup({ use: { agent } });

let collector: OtlpCollector;

beforeAll(async () => {
	collector = await startOtlpCollector();
	exportTracesTo(collector);
});

afterAll(() => collector?.close());

test("without an SDK, a run answers, and only RivetKit's spans are exported", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate(["no-sdk", randomUUID()]);

	await expect(handle.prompt("hello")).resolves.toMatchObject({
		status: "done",
		text: "hi",
	});

	await collector.quiet();
	const names = collector.spans().map((span) => span.name);
	expect(names).toContain("agent/prompt");
	expect(names.filter((name) => name.startsWith("pi."))).toEqual([]);
	expect(names).not.toContain("invoke_agent pi");
});
