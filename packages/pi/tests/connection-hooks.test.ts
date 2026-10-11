import { randomUUID } from "node:crypto";
import {
	createRegistry,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { setup, UserError } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { describe, expect, test } from "vitest";
import { pi } from "../src/index.js";

const users = new Map([["good-token", { id: "user-1" }]]);

// No casts: `params` and `c.conn.state` keep the types `createConnState` gives them.
const agent = pi({
	registry: createRegistry(),
	createConnState: async (_c, params: { token: string }) => {
		const user = users.get(params.token);
		if (!user) throw new UserError("Bad token.", { code: "unauthorized" });
		return { userId: user.id };
	},
	actions: {
		whoami: (c): string => c.conn.state.userId,
	},
});

const registry = setup({ use: { agent } });

describe("connection hooks in pi()", () => {
	test("a bad token is rejected on a built-in call", async (c) => {
		const { client } = await setupTest(c, registry);
		const handle = client.agent.getOrCreate([randomUUID()], {
			params: { token: "bad-token" },
		});

		await expect(handle.harness.root()).rejects.toMatchObject({
			group: "user",
			code: "unauthorized",
		});
	});

	test("a good token connects, and the app's actions read the connection state", async (c) => {
		const { client } = await setupTest(c, registry);
		const conn = client.agent
			.getOrCreate([randomUUID()], { params: { token: "good-token" } })
			.connect();

		await expect(conn.harness.root()).resolves.toEqual({
			id: ROOT_CONVERSATION_ID,
		});
		expect(await conn.whoami()).toBe("user-1");
		await conn.dispose();
	});
});
