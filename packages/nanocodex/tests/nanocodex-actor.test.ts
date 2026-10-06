import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transport } from "nanocodex/node";
import { type Registry, setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
	chatGptCredentials,
	chatGptSubscription,
	nanocodex,
} from "../src/index.js";
import { jwt, startIssuer } from "./helpers/issuer.js";
import { localSandboxProvider } from "./helpers/local-sandbox.js";
import {
	exec,
	message,
	type ResponsesServer,
	startResponsesServer,
} from "./helpers/responses-server.js";
import { createSleepCounter } from "./helpers/sleeps.js";

const SECRET = "test-secret";
// The engine keeps actor state between runs, so each run seeds its own credentials actor.
const CREDENTIALS_KEY = [randomUUID()];

let model: ResponsesServer;
let issuer: Awaited<ReturnType<typeof startIssuer>>;
let sandboxRoot: string;
let registry: ReturnType<typeof buildRegistry>;
const sleeps = createSleepCounter();

function buildRegistry() {
	const transport = () =>
		Transport.openAi({ apiKey: "test-key", websocketUrl: model.url });
	const nap = (c: { sleep(): void }) => {
		c.sleep();
	};
	const coder = nanocodex({
		transport,
		onSleep: sleeps.record,
		actions: { nap },
	});
	// A short grace period, so a stop reaches the drain deadline mid-turn.
	const hasty = nanocodex({
		transport,
		onSleep: sleeps.record,
		options: { sleepGracePeriod: 2_000 },
		actions: { nap },
	});
	const sandboxed = nanocodex({
		transport,
		sandbox: localSandboxProvider(sandboxRoot),
	});
	const chatgptCredentials = chatGptCredentials({
		secret: SECRET,
		issuer: issuer.url,
		// Already expired, so the first model call refreshes it.
		seed: {
			accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
			refreshToken: "refresh-1",
			accountId: "account-1",
		},
	});
	const subscriber = nanocodex({
		transport: chatGptSubscription(
			(c) =>
				c
					.client<Registry<{ chatgptCredentials: typeof chatgptCredentials }>>()
					.chatgptCredentials.getOrCreate(CREDENTIALS_KEY, {
						params: { secret: SECRET },
					}),
			{ websocketUrl: model.url },
		),
	});
	return setup({
		use: { coder, hasty, sandboxed, chatgptCredentials, subscriber },
	});
}

/** Resolves `release()` once a test lets the held model reply go. */
function gate() {
	let release!: () => void;
	const opened = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { opened, release };
}

beforeAll(async () => {
	model = await startResponsesServer();
	issuer = await startIssuer();
	sandboxRoot = await mkdtemp(join(tmpdir(), "rivet-nanocodex-test-"));
	registry = buildRegistry();
});

afterAll(async () => {
	await model?.close();
	await issuer?.close();
	if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

describe("nanocodex actor", () => {
	test("the conversation continues after the actor sleeps", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["continues", randomUUID()];
		const handle = client.coder.getOrCreate(key);
		const remember = `remember ${randomUUID()}`;
		await handle.turn.prompt({ input: remember });

		await handle.nap();
		await sleeps.waitFor(key, 1);

		const recall = `recall ${randomUUID()}`;
		await handle.turn.prompt({ input: recall });
		const request = model.requests.find((r) => r.prompt === recall);
		expect(JSON.stringify(request?.body.input)).toContain(remember);
	});

	test("prompting a finished turn id after a sleep returns its result without a model call", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["replays", randomUUID()];
		const handle = client.coder.getOrCreate(key);
		const input = `answer once ${randomUUID()}`;
		model.reply(input, () => [message("the only answer")]);
		const id = randomUUID();
		const first = await handle.turn.prompt({ id, input });

		await handle.nap();
		await sleeps.waitFor(key, 1);

		const again = await handle.turn.prompt({ id, input });
		expect(again.finalMessage).toBe("the only answer");
		expect(again.finalMessage).toBe(first.finalMessage);
		expect(model.requests.filter((r) => r.prompt === input)).toHaveLength(1);
	});

	test("two prompts with the id of a running turn share that turn", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.coder.getOrCreate(["joins", randomUUID()]);
		const input = `held ${randomUUID()}`;
		const held = gate();
		model.reply(input, async () => {
			await held.opened;
			return [message("shared answer")];
		});
		const id = randomUUID();
		const first = handle.turn.prompt({ id, input });
		// The second prompt must arrive while the first one's model call is held.
		await vi.waitFor(() =>
			expect(model.requests.some((r) => r.prompt === input)).toBe(true),
		);
		const second = handle.turn.prompt({ id, input });
		// The reply stays held until the second prompt reaches the actor. A reply
		// sent sooner would finish the turn first and hide a broken join.
		setTimeout(held.release, 1_000);

		const results = await Promise.all([first, second]);
		expect(results.map((r) => r.finalMessage)).toEqual([
			"shared answer",
			"shared answer",
		]);
		expect(model.requests.filter((r) => r.prompt === input)).toHaveLength(1);
	});

	test("a turn running when the actor sleeps finishes before the actor stops", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["drains", randomUUID()];
		const handle = client.coder.getOrCreate(key);
		const input = `slow ${randomUUID()}`;
		const held = gate();
		model.reply(input, async () => {
			await held.opened;
			return [message("finished during the drain")];
		});
		const running = handle.turn.prompt({ input });
		// The sleep must start while the model call is held.
		await vi.waitFor(() =>
			expect(model.requests.some((r) => r.prompt === input)).toBe(true),
		);
		await handle.nap();
		setTimeout(held.release, 1_000);

		await expect(running).resolves.toMatchObject({
			finalMessage: "finished during the drain",
		});
		await sleeps.waitFor(key, 1);
	});

	test("a turn cut off at the drain deadline resumes when its id is prompted after the actor wakes", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["resumes", randomUUID()];
		const handle = client.hasty.getOrCreate(key);
		const input = `two steps ${randomUUID()}`;
		const held = gate();
		model.reply(input, async (request) => {
			if (request.step === 0) return [exec('text("step one done")')];
			if (request.step === 1) await held.opened;
			return [message("both steps done")];
		});
		const id = randomUUID();
		const cutOff = handle.turn.prompt({ id, input });
		// The stop must start while the second model call is held.
		await vi.waitFor(() =>
			expect(model.requests.filter((r) => r.prompt === input)).toHaveLength(2),
		);
		await handle.nap();
		await expect(cutOff).rejects.toThrow();
		await sleeps.waitFor(key, 1);
		held.release();

		await expect(handle.turn.prompt({ id, input })).resolves.toMatchObject({
			finalMessage: "both steps done",
		});
		const calls = model.requests.filter((r) => r.prompt === input);
		// The first model call completed before the stop, so it is not sent again.
		const firstCalls = calls.filter(
			(r) => !JSON.stringify(r.body.input).includes("step one done"),
		);
		expect(firstCalls).toHaveLength(1);
	});

	test("the agent's file tools and exec_command run in the sandbox", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.sandboxed.getOrCreate(["sandbox", randomUUID()]);
		const input = `use the sandbox ${randomUUID()}`;
		model.reply(input, (request) =>
			request.step === 0
				? [
						exec(
							'await tools.write_file({ path: "notes/hello.txt", content: "hi from nanocodex" }); const r = await tools.exec_command({ cmd: "cat notes/hello.txt" }); text(r.output)',
						),
					]
				: [message("done")],
		);
		await handle.turn.prompt({ input });

		const toolOutput = model.requests.find(
			(r) => r.prompt === input && r.step === 1,
		);
		expect(JSON.stringify(toolOutput?.body.input)).toContain(
			"hi from nanocodex",
		);
		const sandboxes = await readdir(sandboxRoot);
		const contents = await Promise.all(
			sandboxes.map((id) =>
				readFile(join(sandboxRoot, id, "notes/hello.txt"), "utf8").catch(
					() => undefined,
				),
			),
		);
		expect(contents).toContain("hi from nanocodex");
	});

	test("the credentials actor rejects a caller without its secret", async (c) => {
		const { client } = await setupTest(c, registry);
		const key = ["rejects", randomUUID()];
		await expect(
			client.chatgptCredentials.getOrCreate(key).status(),
		).rejects.toMatchObject({
			code: "unauthorized",
		});
		await expect(
			client.chatgptCredentials
				.getOrCreate(key, { params: { secret: SECRET } })
				.status(),
		).resolves.toMatchObject({
			state: "authenticated",
			accountId: "account-1",
		});
	});

	test("conversation actors that hit an expired ChatGPT token refresh it once", async (c) => {
		const { client } = await setupTest(c, registry);
		const before = issuer.refreshes;
		const input = `subscribed ${randomUUID()}`;
		const results = await Promise.all(
			[0, 1].map(() =>
				client.subscriber
					.getOrCreate(["subscriber", randomUUID()])
					.turn.prompt({
						input,
					}),
			),
		);
		expect(results.map((r) => r.finalMessage)).toEqual(["ok", "ok"]);
		expect(issuer.refreshes - before).toBe(1);
		for (const request of model.requests.filter((r) => r.prompt === input)) {
			expect(request.headers["chatgpt-account-id"]).toBe("account-1");
			const token = String(request.headers.authorization).replace(
				"Bearer ",
				"",
			);
			const claims = JSON.parse(
				Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
			);
			expect(claims.generation).toBe(before + 1);
		}
	});
});
