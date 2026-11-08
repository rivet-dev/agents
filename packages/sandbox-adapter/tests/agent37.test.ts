import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { agent37Provider } from "../src/agent37.js";
import type { Sandbox, SandboxActorContext } from "../src/index.js";

const context: SandboxActorContext = {
	actorId: "agent37-provider-test",
	client: () => undefined,
};

describe.skipIf(!process.env.AGENT37_API_KEY)("agent37 provider", () => {
	const provider = agent37Provider();
	const created: string[] = [];
	let sandbox: Sandbox;

	async function start() {
		const id = await provider.create(context);
		created.push(id);
		const connected = await provider.connect(context, id);
		if (!connected) throw new Error("new sandbox did not connect");
		return { id, sandbox: connected };
	}

	const run = (command: string, timeoutMs?: number) =>
		sandbox.exec(command, { cwd: sandbox.cwd, timeoutMs });

	beforeAll(async () => {
		({ sandbox } = await start());
	}, 120_000);

	afterAll(async () => {
		await Promise.all(created.map((id) => provider.destroy?.(context, id)));
	}, 120_000);

	test("the working directory defaults to the sandbox's home", () => {
		expect(sandbox.cwd).toBe("/home/node");
	});

	test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
		await sandbox.mkdir(`${sandbox.cwd}/sub`);
		const chunks: string[] = [];
		const result = await sandbox.exec(
			'echo "$GREETING it\'s $NAME"; pwd; echo oops >&2; exit 3',
			{
				cwd: `${sandbox.cwd}/sub`,
				env: { GREETING: "hello", NAME: "world" },
				onData: (chunk) => chunks.push(Buffer.from(chunk).toString()),
			},
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: "hello it's world\n/home/node/sub\n",
			stderr: "oops\n",
		});
		expect(chunks.join("")).toBe("hello it's world\n/home/node/sub\noops\n");
	});

	test("aborting kills the command", async () => {
		const controller = new AbortController();
		const pending = sandbox.exec("sleep 3071", {
			cwd: sandbox.cwd,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		expect((await run("ps -eo args")).stdout).not.toContain("sleep 3071");
	}, 60_000);

	test("a timeout kills the command and reports it", async () => {
		const startedAt = Date.now();
		const result = await run("echo started; sleep 3072", 2_000);
		expect(Date.now() - startedAt).toBeLessThan(20_000);
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: true,
			stdout: "started\n",
		});
		expect((await run("ps -eo args")).stdout).not.toContain("sleep 3072");
	}, 60_000);

	test("files round trip and missing files fail", async () => {
		const dir = `${sandbox.cwd}/files`;
		const content = "line one\nline two with ünïcode\n";
		await sandbox.mkdir(`${dir}/nested`);
		await sandbox.writeFile(`${dir}/a.txt`, content);
		await sandbox.writeFile(`${dir}/.hidden`, "");
		await sandbox.writeFile(`${dir}/-dash it's`, "odd name");
		expect(Buffer.from(await sandbox.readFile(`${dir}/a.txt`)).toString()).toBe(
			content,
		);
		expect(Buffer.from(await sandbox.readFile(`${dir}/.hidden`)).length).toBe(
			0,
		);
		expect(
			Buffer.from(await sandbox.readFile(`${dir}/-dash it's`)).toString(),
		).toBe("odd name");
		expect((await sandbox.readdir(dir)).sort()).toEqual([
			"-dash it's",
			".hidden",
			"a.txt",
			"nested",
		]);
		expect(await sandbox.stat(`${dir}/nested`)).toEqual({ isDirectory: true });
		expect(await sandbox.stat(`${dir}/a.txt`)).toEqual({ isDirectory: false });
		expect(await sandbox.exists(`${dir}/a.txt`)).toBe(true);
		expect(await sandbox.exists(`${dir}/missing`)).toBe(false);
		await expect(sandbox.readFile(`${dir}/missing`)).rejects.toThrow();
		await expect(sandbox.readFile(`${dir}/nested`)).rejects.toThrow();
		await expect(sandbox.stat(`${dir}/missing`)).rejects.toThrow();
		await expect(sandbox.readdir(`${dir}/missing`)).rejects.toThrow();
	}, 120_000);

	test("files larger than one exec request round trip byte for byte", async () => {
		const path = `${sandbox.cwd}/big.txt`;
		const content = Array.from(
			{ length: 70_000 },
			(_, i) => `line ${i} ünïcode\n`,
		).join("");
		expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
		await sandbox.writeFile(path, content);
		expect(Buffer.from(await sandbox.readFile(path)).toString()).toBe(content);
		expect((await run(`wc -c < ${path}`)).stdout.trim()).toBe(
			String(Buffer.byteLength(content)),
		);
	}, 120_000);

	test("binary files read back exactly", async () => {
		const path = `${sandbox.cwd}/bytes.bin`;
		await run(`printf '\\377\\000\\376x' > ${path}`);
		expect([...(await sandbox.readFile(path))]).toEqual([255, 0, 254, 120]);
	});

	test("a write into a missing directory fails and creates nothing", async () => {
		await expect(
			sandbox.writeFile(`${sandbox.cwd}/missing/dir/a.txt`, "x"),
		).rejects.toThrow();
		await expect(
			sandbox.writeFile(
				`${sandbox.cwd}/missing/dir/big.txt`,
				"x".repeat(2 * 1024 * 1024),
			),
		).rejects.toThrow();
		expect(await sandbox.exists(`${sandbox.cwd}/missing`)).toBe(false);
	}, 120_000);

	test("a suspended sandbox keeps its files and a destroyed one is gone", async () => {
		const { id, sandbox: first } = await start();
		await first.writeFile(`${first.cwd}/kept.txt`, "kept");
		await provider.suspend?.(context, id);
		const resumed = await provider.connect(context, id);
		expect(
			Buffer.from(
				(await resumed?.readFile(`${first.cwd}/kept.txt`)) ?? [],
			).toString(),
		).toBe("kept");
		await provider.destroy?.(context, id);
		expect(await provider.connect(context, id)).toBeUndefined();
	}, 180_000);

	test("a custom cwd is created on connect", async () => {
		const custom = agent37Provider({ cwd: "/workspace" });
		const id = await custom.create(context);
		created.push(id);
		const connected = await custom.connect(context, id);
		expect(connected?.cwd).toBe("/workspace");
		expect(await connected?.stat("/workspace")).toEqual({ isDirectory: true });
	}, 120_000);
});

test("the agent37 provider rejects a relative cwd", () => {
	expect(() => agent37Provider({ cwd: "workspace" })).toThrow();
});
