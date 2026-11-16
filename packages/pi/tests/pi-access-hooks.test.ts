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
	state: { count: 0 },
	run: async (c) => {
		record(c.key, "run", String((await c.pi.root(BACKGROUND_CONTEXT)).id));
	},
	onStateChange: (c, state) => {
		record(c.key, "onStateChange", `${state.count} ${c.pi.wake().active}`);
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
			c.state.count += 1;
			return { count: c.state.count };
		},
	},
});
const registry = setup({ use: { agent } });

test("run, onStateChange, onBeforeActionResponse, onRequest, and onWebSocket get c.pi", async (c) => {
	const { client } = await setupTest(c, registry);
	const key = ["hooks", randomUUID()];
	const handle = client.agent.getOrCreate(key);
	const rootId = (await handle.harness.root()).id;

	expect(await handle.bump()).toEqual({ count: 1, rootId });
	expect(await (await handle.fetch("/root")).text()).toBe(String(rootId));
	const websocket = await handle.webSocket("/root");
	const message = await new Promise<string>((resolve) => {
		websocket.addEventListener("message", (event: { data: unknown }) =>
			resolve(String(event.data)),
		);
	});
	websocket.close();
	expect(message).toBe(String(rootId));

	await vi.waitFor(() =>
		expect(seen.get(key.join("/"))).toEqual({
			run: String(rootId),
			onStateChange: "1 false",
		}),
	);
});
