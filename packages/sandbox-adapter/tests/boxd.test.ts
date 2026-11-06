import { randomUUID } from "node:crypto";
import {
	AuthenticationError,
	Boxd,
	ConflictError,
	type MachineCreateParams,
	NotFoundError,
} from "@boxd-sh/sdk";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type BoxdProviderOptions, boxdProvider } from "../src/boxd.js";
import type { Sandbox, SandboxActorContext } from "../src/index.js";

const context: SandboxActorContext = {
	actorId: "boxd-provider-test",
	client: () => undefined,
};

/** A client whose `machines` calls are mocks. Only what a test sets is defined. */
function fakeClient(machines: Record<string, unknown>): Boxd {
	return { machines } as unknown as Boxd;
}

describe("boxd provider", () => {
	test("rejects a relative cwd", () => {
		expect(() => boxdProvider({ cwd: "work" })).toThrow();
	});

	test("creates the client on first use", () => {
		const provider = boxdProvider();
		expect(provider).toMatchObject({ name: "boxd", cwd: "/home/boxd" });
	});

	test("create passes the Actor context to a create function", async () => {
		const create = vi.fn(async () => ({ id: "machine-1" }));
		const provider = boxdProvider({
			client: fakeClient({ create }),
			create: (c) => ({ name: `agent-${c.actorId}` }),
		});
		expect(await provider.create(context)).toBe("machine-1");
		expect(create).toHaveBeenCalledWith({ name: "agent-boxd-provider-test" });
	});

	test.each([
		["running", undefined],
		["suspended", "resume"],
		["hibernated", "wake"],
		["stopped", "start"],
	])("connect to a %s machine calls %s", async (status, call) => {
		const machines = {
			get: vi.fn(async () => ({ status })),
			resume: vi.fn(async () => {}),
			wake: vi.fn(async () => {}),
			start: vi.fn(async () => {}),
			waitUntilReady: vi.fn(async () => {}),
			fs: { mkdir: vi.fn(async () => {}) },
		};
		const provider = boxdProvider({ client: fakeClient(machines), cwd: "/w" });
		const sandbox = await provider.connect(context, "machine-1");
		expect(sandbox?.cwd).toBe("/w");
		for (const name of ["resume", "wake", "start"] as const) {
			expect(machines[name]).toHaveBeenCalledTimes(name === call ? 1 : 0);
		}
		expect(machines.waitUntilReady).toHaveBeenCalledWith("machine-1");
		expect(machines.fs.mkdir).toHaveBeenCalledWith("machine-1", "/w");
	});

	test("connect returns undefined for a missing or destroyed machine", async () => {
		const missing = boxdProvider({
			client: fakeClient({
				get: async () => {
					throw new NotFoundError("machine not found");
				},
			}),
		});
		expect(await missing.connect(context, "machine-1")).toBeUndefined();
		const destroyed = boxdProvider({
			client: fakeClient({ get: async () => ({ status: "destroyed" }) }),
		});
		expect(await destroyed.connect(context, "machine-1")).toBeUndefined();
	});

	test("connect throws other errors, so the sandbox id is kept", async () => {
		const provider = boxdProvider({
			client: fakeClient({
				get: async () => {
					throw new Error("unavailable");
				},
			}),
		});
		await expect(provider.connect(context, "machine-1")).rejects.toThrow(
			"unavailable",
		);
	});

	test("suspend and destroy ignore a machine that is already gone", async () => {
		const gone = async () => {
			throw new NotFoundError("machine not found");
		};
		const provider = boxdProvider({
			client: fakeClient({ hibernate: gone, delete: gone }),
		});
		await provider.suspend?.(context, "machine-1");
		await provider.destroy?.(context, "machine-1");
	});

	test("suspend leaves a stopped machine stopped and throws other conflicts", async () => {
		let status = "stopped";
		const provider = boxdProvider({
			client: fakeClient({
				hibernate: async () => {
					throw new ConflictError("VM is stopped");
				},
				get: async () => ({ status }),
			}),
		});
		await provider.suspend?.(context, "machine-1");
		status = "migrating";
		await expect(provider.suspend?.(context, "machine-1")).rejects.toThrow(
			ConflictError,
		);
	});

	test("exec runs the whole command with its env and cwd", async () => {
		const streamExec = vi.fn(() => {
			throw new Error("stop here");
		});
		const machines = {
			get: async () => ({ status: "running" }),
			waitUntilReady: async () => {},
			fs: { mkdir: async () => {} },
			streamExec,
		};
		const provider = boxdProvider({ client: fakeClient(machines) });
		const sandbox = await provider.connect(context, "machine-1");
		await expect(
			sandbox?.exec("echo $A; echo it's", {
				cwd: "/home/boxd/my dir",
				env: { A: "x y" },
			}),
		).rejects.toThrow("stop here");
		expect(streamExec).toHaveBeenCalledWith("machine-1", {
			command: `cd '/home/boxd/my dir' && exec env 'A=x y' /bin/sh -c 'echo $A; echo it'"'"'s'`,
			closeStdin: true,
		});
		await expect(
			sandbox?.exec("true", { cwd: "/", env: { "A;B": "1" } }),
		).rejects.toThrow("invalid environment variable name");
	});
});

// Live tests against boxd. Each run creates two machines and deletes them.
// BOXD_TEST_NAME_PREFIX and BOXD_TEST_LABELS (`key=value,key=value`) name and
// label them, so a shared organization can tell test machines apart.
const apiKey = process.env.BOXD_API_KEY;
const namePrefix = process.env.BOXD_TEST_NAME_PREFIX ?? "sandbox-adapter-test";
const labels = Object.fromEntries(
	(process.env.BOXD_TEST_LABELS ?? "")
		.split(",")
		.filter(Boolean)
		.map((pair) => pair.split("=", 2) as [string, string]),
);

describe.skipIf(!apiKey)("boxd provider against boxd", () => {
	const client = new Boxd({ apiKey });
	const created: { provider: ReturnType<typeof boxdProvider>; id: string }[] =
		[];
	let sandbox: Sandbox;

	function machine(): MachineCreateParams {
		// deleteAfter is a safety net for a run that dies before afterAll.
		return {
			name: `${namePrefix}-${randomUUID().slice(0, 8)}`,
			labels,
			deleteAfter: 3600,
		};
	}

	async function start(options: Omit<BoxdProviderOptions, "client"> = {}) {
		const provider = boxdProvider({ client, create: machine, ...options });
		const id = await provider.create(context);
		created.push({ provider, id });
		const connected = await provider.connect(context, id);
		if (!connected) throw new Error("new sandbox did not connect");
		return { provider, id, sandbox: connected };
	}

	const run = (command: string, timeoutMs?: number) =>
		sandbox.exec(command, { cwd: sandbox.cwd, timeoutMs });

	beforeAll(async () => {
		({ sandbox } = await start({ cwd: "/home/boxd/workspace" }));
	});

	afterAll(async () => {
		await Promise.all(
			created.map(({ provider, id }) => provider.destroy?.(context, id)),
		);
	});

	test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
		await sandbox.mkdir("/home/boxd/workspace/sub");
		const result = await sandbox.exec(
			'echo "hello $NAME"; pwd; echo oops >&2; exit 3',
			{ cwd: "/home/boxd/workspace/sub", env: { NAME: "wor'ld" } },
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: "hello wor'ld\n/home/boxd/workspace/sub\n",
			stderr: "oops\n",
		});
	});

	test("output streams before the command ends, and aborting kills it", async () => {
		const controller = new AbortController();
		const marker = `stream-${randomUUID()}`;
		let streamed: (chunk: string) => void = () => {};
		const firstChunk = new Promise<string>((resolve) => {
			streamed = resolve;
		});
		const pending = sandbox.exec(`echo ${marker}; sleep 300`, {
			cwd: sandbox.cwd,
			signal: controller.signal,
			onData: (chunk) => streamed(Buffer.from(chunk).toString()),
		});
		expect(await firstChunk).toBe(`${marker}\n`);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect((await run("ps -eo args")).stdout).not.toContain("sleep 300");
	});

	test("a timeout kills the command and reports it", async () => {
		const startedAt = Date.now();
		const result = await run("echo started; sleep 300", 3_000);
		expect(Date.now() - startedAt).toBeLessThan(15_000);
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: true,
			stdout: "started\n",
		});
		expect((await run("ps -eo args")).stdout).not.toContain("sleep 300");
	});

	test("a timeout that ends before the command connects still returns", async () => {
		const result = await run("sleep 300", 1);
		expect(result).toMatchObject({ exitCode: null, timedOut: true });
	});

	test("files round trip and missing files fail", async () => {
		const content = "line one\nline two with ünïcode\n";
		await sandbox.mkdir("/home/boxd/workspace/files/nested");
		await sandbox.writeFile("/home/boxd/workspace/files/a.txt", content);
		await sandbox.writeFile("/home/boxd/workspace/files/.hidden", "");
		expect(
			Buffer.from(
				await sandbox.readFile("/home/boxd/workspace/files/a.txt"),
			).toString(),
		).toBe(content);
		expect(
			(await sandbox.readdir("/home/boxd/workspace/files")).sort(),
		).toEqual([".hidden", "a.txt", "nested"]);
		expect(await sandbox.stat("/home/boxd/workspace/files/nested")).toEqual({
			isDirectory: true,
		});
		expect(await sandbox.stat("/home/boxd/workspace/files/a.txt")).toEqual({
			isDirectory: false,
		});
		expect(await sandbox.exists("/home/boxd/workspace/files/a.txt")).toBe(true);
		expect(await sandbox.exists("/home/boxd/workspace/files/missing")).toBe(
			false,
		);
		await expect(
			sandbox.readFile("/home/boxd/workspace/files/missing"),
		).rejects.toThrow();
		await expect(
			sandbox.stat("/home/boxd/workspace/files/missing"),
		).rejects.toThrow();
		expect(
			(await run("cat files/a.txt && stat -c %U files/a.txt")).stdout,
		).toBe(`${content}boxd\n`);
	});

	test("host env vars are invisible inside the machine", async () => {
		const env = await run("env");
		expect(env.stdout).not.toContain("BOXD_API_KEY");
		expect(env.stdout).not.toContain(apiKey);
	});

	test("a suspended sandbox keeps its files and a destroyed one is gone", async () => {
		const { provider, id, sandbox: first } = await start();
		await first.writeFile("/home/boxd/kept.txt", "kept");
		await provider.suspend?.(context, id);
		const resumed = await provider.connect(context, id);
		expect(
			Buffer.from(
				(await resumed?.readFile("/home/boxd/kept.txt")) ?? [],
			).toString(),
		).toBe("kept");
		expect(
			(await resumed?.exec("echo resumed", { cwd: "/home/boxd" }))?.stdout,
		).toBe("resumed\n");
		await provider.destroy?.(context, id);
		expect(await provider.connect(context, id)).toBeUndefined();
		await provider.destroy?.(context, id);
	});

	test("a wrong API key fails with AuthenticationError and creates nothing", async () => {
		const provider = boxdProvider({
			client: new Boxd({ apiKey: "not-a-boxd-key" }),
			create: machine,
		});
		await expect(provider.create(context)).rejects.toBeInstanceOf(
			AuthenticationError,
		);
	});
});
