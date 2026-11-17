import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { pi } from "../src/index.js";

/** What each hook read from `c.pi`, by actor key, in this process where the actors run. */
const seen = new Map<string, Record<string, string>>();
const record = (key: string[], hook: string, value: string) => {
	const id = key.join("/");
	seen.set(id, { ...seen.get(id), [hook]: value });
};

const agent = pi({
	createVars: () => ({ count: 0 }),
	run: async (c) => {
		record(c.key, "run", String((await c.pi.root(BACKGROUND_CONTEXT)).id));
	},
	onBeforeActionResponse: async (c, name, _args, output) => {
		if (name !== "bump") return output;
		const root = await c.pi.root(BACKGROUND_CONTEXT);
		return { ...(output as object), rootId: root.id } as typeof output;
	},
	onRequest: async (c) =>
		new Response(String((await c.pi.root(BACKGROUND_CONTEXT)).id)),
	onWebSocket: async (c, websocket) => {
		const root = await c.pi.root(BACKGROUND_CONTEXT);
		websocket.send(String(root.id));
	},
	actions: {
		bump: (c) => {
			c.vars.count += 1;
			return { count: c.vars.count };
		},
	},
});

/** Its `run` lasts until Pi Durable closes, like a loop that waits on Pi. */
const waiting = pi({
	createVars: () => ({ generation: randomUUID() }),
	// Long enough that a sleep held to the drain deadline (45 s here) shows.
	options: { sleepGracePeriod: 60_000 },
	run: async (c) => {
		await new Promise<void>((resolve) => c.pi.subscribeClose(() => resolve()));
	},
	actions: {
		generation: (c) => c.vars.generation,
		nap: (c) => {
			c.sleep();
		},
	},
});

const registry = setup({ use: { agent, waiting } });

test("run, onBeforeActionResponse, onRequest, and onWebSocket get c.pi", async (c) => {
	const { client } = await setupTest(c, registry);
	const key = ["hooks", randomUUID()];
	const handle = client.agent.getOrCreate(key);
	const rootId = (await handle.harness.root()).id;

	expect(await handle.bump()).toEqual({ count: 1, rootId });
	expect(await (await handle.fetch("/root")).text()).toBe(String(rootId));
	const websocket = await handle.webSocket("/root");
	const message = await new Promise<string>((resolve, reject) => {
		websocket.addEventListener("message", (event: { data: unknown }) =>
			resolve(String(event.data)),
		);
		websocket.addEventListener("close", () =>
			reject(new Error("the socket closed before onWebSocket sent")),
		);
	});
	websocket.close();
	expect(message).toBe(String(rootId));

	await vi.waitFor(() =>
		expect(seen.get(key.join("/"))).toEqual({ run: String(rootId) }),
	);
});

test("a run that waits on Pi does not hold a sleep until the drain deadline", async (c) => {
	const { client } = await setupTest(c, registry);
	const handle = client.waiting.getOrCreate(["waiting", randomUUID()]);
	const before = await handle.generation();

	await handle.nap();
	// A new generation answers once the old one stopped. Pi has no work left, so
	// the stop needs only the close, not the drain's 45 seconds.
	await vi.waitFor(
		async () => expect(await handle.generation()).not.toBe(before),
		{ timeout: 30_000, interval: 250 },
	);
}, 60_000);
