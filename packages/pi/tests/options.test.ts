import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, expect, test } from "vitest";
import { pi } from "../src/index.js";
import { localSandboxProvider } from "./helpers/local-sandbox.js";
import { createMockModel, toolCall } from "./helpers/mock-model.js";

const root = await mkdtemp(join(tmpdir(), "rivet-pi-options-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const mock = createMockModel();
mock.reply(
	"create hello.txt",
	toolCall("write", { path: "hello.txt", content: "hi from pi\n" }),
	fauxAssistantMessage("written"),
);
const models = {
	model: "mock/mock-model",
	providers: { mock: mock.providerConfig },
	apiKeys: { mock: "mock" },
};

// No registry: the sandbox brings Pi's coding tools.
const coder = pi({
	...models,
	sandbox: localSandboxProvider(join(root, "coder")),
});
// Only `read` of the coding tools.
const reader = pi({
	...models,
	sandbox: localSandboxProvider(join(root, "reader")),
	codingTools: ["read"],
});
const configured = pi({
	...models,
	instructions: "Fix one project, then stop.",
	cwd: "/workspace",
	maxTurns: 4,
	actions: {
		agentOf: (c, id: ConversationId) =>
			c.pi.commit(async (tx) => {
				const agent = await tx.doc(AgentDoc, id);
				return {
					instructions: agent.instructions,
					cwd: agent.cwd,
					maxTurns: agent.maxTurns,
				};
			}, BACKGROUND_CONTEXT),
	},
});
const registry = setup({ use: { coder, reader, configured } });

test("a sandbox without a registry gets Pi's coding tools", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.coder.getOrCreate([randomUUID()]);

	expect(await handle.prompt("create hello.txt")).toMatchObject({
		status: "done",
		text: "written",
	});
	const [sandboxId] = await readdir(join(root, "coder"));
	expect(
		await readFile(
			join(root, "coder", sandboxId as string, "hello.txt"),
			"utf8",
		),
	).toBe("hi from pi\n");
});

test("codingTools installs only the coding tools it lists", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.reader.getOrCreate([randomUUID()]);
	const conversation = await handle.harness.root();

	await handle.prompt("create hello.txt");
	const { messages } = await handle.conversation.context(conversation.id);
	expect(
		messages.find((message) => message.role === "toolResult"),
	).toMatchObject({ toolName: "write", isError: true });
	for (const sandboxId of await readdir(join(root, "reader")).catch(() => [])) {
		expect(await readdir(join(root, "reader", sandboxId))).not.toContain(
			"hello.txt",
		);
	}
});

test("instructions, cwd, and maxTurns start every new conversation", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.configured.getOrCreate([randomUUID()]);
	const conversation = await handle.harness.root();

	expect(await handle.agentOf(conversation.id)).toEqual({
		instructions: "Fix one project, then stop.",
		cwd: "/workspace",
		maxTurns: 4,
	});
});
