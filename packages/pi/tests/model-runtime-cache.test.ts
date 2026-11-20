import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PiCredentialStore } from "../src/models.js";
import { createActorModelRuntime } from "../src/models.js";
import { createMockModel } from "./helpers/mock-model.js";

const providers = { mock: createMockModel().providerConfig };

/** A credential store that serves one API key for provider `mock` and counts reads. */
function store(key: string | undefined) {
	const reads: string[] = [];
	const credentials: PiCredentialStore = {
		read: async (providerId) => {
			reads.push(providerId);
			return key === undefined ? undefined : { type: "api_key", key };
		},
		list: async () => [],
		modify: async () => undefined,
		delete: async () => {},
	};
	return { credentials, reads };
}

async function keyOf(runtime: ModelRuntime, credentials: string) {
	const model = runtime.getModel("mock", "mock-model");
	if (!model) throw new Error(`no mock model for ${credentials}`);
	const auth = await runtime.getAuth(model);
	return auth?.auth.apiKey;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("model runtime per actor", () => {
	test("is built once across the wakes of one actor", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const options = { providers };
		for (let wake = 0; wake < 5; wake++) {
			await createActorModelRuntime(
				options,
				store("k").credentials,
				"cache-once",
			);
		}
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("a reused runtime reads the credentials of the current wake", async () => {
		const first = store("key-1");
		const second = store("key-2");
		const options = { providers };
		const a = await createActorModelRuntime(
			options,
			first.credentials,
			"cache-creds",
		);
		expect(await keyOf(a, "first")).toBe("key-1");
		const b = await createActorModelRuntime(
			options,
			second.credentials,
			"cache-creds",
		);
		const readsBefore = first.reads.length;
		expect(await keyOf(b, "second")).toBe("key-2");
		expect(first.reads.length).toBe(readsBefore);
		expect(second.reads.length).toBeGreaterThan(0);
	});

	test("actors never share a runtime or its credentials", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const options = { providers };
		const one = await createActorModelRuntime(
			options,
			store("key-one").credentials,
			"cache-actor-1",
		);
		const two = await createActorModelRuntime(
			options,
			store("key-two").credentials,
			"cache-actor-2",
		);
		expect(create).toHaveBeenCalledTimes(2);
		expect(await keyOf(one, "one")).toBe("key-one");
		expect(await keyOf(two, "two")).toBe("key-two");
	});

	test("changed options build a new runtime, key order does not", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		const run = (options: Parameters<typeof createActorModelRuntime>[0]) =>
			createActorModelRuntime(
				options,
				store(undefined).credentials,
				"cache-opts",
			);
		await run({ providers, apiKeys: { mock: "a", other: "b" } });
		await run({ providers, apiKeys: { other: "b", mock: "a" } });
		expect(create).toHaveBeenCalledTimes(1);
		const changed = await run({ providers, apiKeys: { mock: "changed" } });
		expect(create).toHaveBeenCalledTimes(2);
		expect(await keyOf(changed, "changed")).toBe("changed");
		await run({
			providers,
			apiKeys: { mock: "changed" },
			model: "mock/mock-model",
		});
		expect(create).toHaveBeenCalledTimes(3);
	});

	test("without an actor id nothing is cached", async () => {
		const create = vi.spyOn(ModelRuntime, "create");
		for (let wake = 0; wake < 3; wake++) {
			await createActorModelRuntime({ providers }, store("k").credentials);
		}
		expect(create).toHaveBeenCalledTimes(3);
	});
});
