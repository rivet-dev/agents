import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contentText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	type SubmissionId,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { beforeAll, describe, expect, test } from "vitest";
import { pi } from "../src/index.js";
import { createMockModel, toolCall } from "./helpers/mock-model.js";

type Seeded = {
	conversationId: ConversationId;
	submissionId: SubmissionId;
};

const SEED_SCRIPT = fileURLToPath(
	new URL("./published-0.5.5/seed.mjs", import.meta.url),
);

const mock = createMockModel();
mock.reply("flaky", fauxAssistantMessage("recovered after the upgrade"));
mock.reply(
	"run the tool",
	toolCall("slow_tool", {}),
	fauxAssistantMessage("the tool finished"),
);
mock.reply("stream a story", fauxAssistantMessage("the story, told again"));
mock.reply("after the upgrade", fauxAssistantMessage("still answering"));

const slowTool = defineTool({
	name: "slow_tool",
	description: "A tool that was running when the process died",
	parameters: obj({}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "tool output" }] }),
});
const extensions = createRegistry();
extensions.install(defineExtension({ name: "seed", tools: [slowTool] }));
const agent = pi({
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
	registry: extensions,
	settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 } },
});
const registry = setup({ use: { agent } });

/**
 * Runs the published 0.5.5 in its own process against this file's engine data,
 * and kills it, with its engine, when it reports the actors have work in flight.
 */
async function seedOnPublishedThenCrash(): Promise<Record<string, Seeded>> {
	const seed: ChildProcess = spawn(process.execPath, [SEED_SCRIPT], {
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	seed.stderr?.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-4_000);
	});
	try {
		return await new Promise((resolve, reject) => {
			seed.stdout?.on("data", (chunk) => {
				stdout += chunk;
				const seeded = /^SEEDED (.+)$/m.exec(stdout);
				if (seeded?.[1]) resolve(JSON.parse(seeded[1]));
			});
			seed.once("exit", (code) =>
				reject(new Error(`the seed exited with ${code}: ${stderr}`)),
			);
		});
	} finally {
		if (seed.pid !== undefined) process.kill(-seed.pid, "SIGKILL");
	}
}

const textOf = (message: Parameters<typeof contentText>[0]) =>
	contentText(message, "");

describe("an actor seeded on the published 0.5.5", () => {
	let seeded: Record<string, Seeded>;

	beforeAll(async () => {
		seeded = await seedOnPublishedThenCrash();
	}, 180_000);

	test.for([
		["tool", "tool-crash", "the tool finished"],
		["stream", "stream-crash", "the story, told again"],
		["backoff", "backoff", "recovered after the upgrade"],
	] as const)("the run that was in flight (%s) finishes after the upgrade, and a new prompt works", async ([
		name,
		key,
		answer,
	], c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate([key]);
		const { conversationId, submissionId } = seeded[name] as Seeded;

		expect(await handle.submission.wait(submissionId)).toMatchObject({
			status: "done",
		});
		const { messages } = await handle.conversation.context(conversationId);
		expect(
			messages.flatMap((message) =>
				message.role === "assistant" ? [textOf(message.content)] : [],
			),
		).toContain(answer);
		expect(await handle.prompt("after the upgrade")).toMatchObject({
			status: "done",
			text: "still answering",
		});
	});

	test("a finished conversation keeps its transcript, answers a new prompt, and can be watched, though its old connection saved an events watch", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate(["finished"]);
		const { conversationId } = seeded.finished as Seeded;

		expect(await handle.prompt("after the upgrade")).toMatchObject({
			status: "done",
			text: "still answering",
		});
		const { messages } = await handle.conversation.context(conversationId);
		expect(
			messages.flatMap((message) =>
				message.role === "assistant" ? [textOf(message.content)] : [],
			),
		).toEqual(["hello from 0.5.5", "still answering"]);

		const conn = handle.connect();
		const { value } = await conn.conversation.watch(conversationId);
		await conn.dispose();
		expect(JSON.stringify(value.entries)).toContain("hello from 0.5.5");
	});
});
