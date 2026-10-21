import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type DockerProviderOptions,
	dockerPortAddress,
	dockerProvider,
} from "../src/docker.js";
import type { Sandbox, SandboxActorContext } from "../src/index.js";

const dockerRunning =
	spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const image = "alpine:3.22";
const context: SandboxActorContext = {
	actorId: "docker-provider-test",
	client: () => undefined,
};

describe.skipIf(!dockerRunning)("docker provider", () => {
	const created: { provider: ReturnType<typeof dockerProvider>; id: string }[] =
		[];
	const hostSecret = `host-secret-${randomUUID()}`;
	let hostDir: string;
	let sandbox: Sandbox;

	async function start(options: DockerProviderOptions = {}) {
		const provider = dockerProvider({ image, ...options });
		const id = await provider.create(context);
		created.push({ provider, id });
		const connected = await provider.connect(context, id);
		if (!connected) throw new Error("new sandbox did not connect");
		return { provider, id, sandbox: connected };
	}

	const run = (command: string, timeoutMs?: number) =>
		sandbox.exec(command, { cwd: sandbox.cwd, timeoutMs });

	beforeAll(async () => {
		process.env.RIVET_DOCKER_TEST_SECRET = hostSecret;
		hostDir = await mkdtemp(join(tmpdir(), "docker-provider-"));
		await writeFile(join(hostDir, "secret.txt"), hostSecret);
		({ sandbox } = await start({ env: { GREETING: "hello" } }));
	});

	afterAll(async () => {
		delete process.env.RIVET_DOCKER_TEST_SECRET;
		await rm(hostDir, { recursive: true, force: true });
		await Promise.all(
			created.map(({ provider, id }) => provider.destroy?.(context, id)),
		);
	});

	test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
		await sandbox.mkdir("/workspace/sub");
		const result = await sandbox.exec(
			'echo "$GREETING $NAME"; pwd; echo oops >&2; exit 3',
			{ cwd: "/workspace/sub", env: { NAME: "world" } },
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: "hello world\n/workspace/sub\n",
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
		expect((await run("ps -o args")).stdout).not.toContain("sleep 300");
	});

	test("a timeout kills the command and reports it", async () => {
		const startedAt = Date.now();
		const result = await run("echo started; sleep 300", 500);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: true,
			stdout: "started\n",
		});
		expect((await run("ps -o args")).stdout).not.toContain("sleep 300");
	});

	test("files round trip and missing files fail", async () => {
		const content = "line one\nline two with ünïcode\n";
		await sandbox.mkdir("/workspace/files/nested");
		await sandbox.writeFile("/workspace/files/a.txt", content);
		await sandbox.writeFile("/workspace/files/.hidden", "");
		expect(
			Buffer.from(await sandbox.readFile("/workspace/files/a.txt")).toString(),
		).toBe(content);
		expect((await sandbox.readdir("/workspace/files")).sort()).toEqual([
			".hidden",
			"a.txt",
			"nested",
		]);
		expect(await sandbox.stat("/workspace/files/nested")).toEqual({
			isDirectory: true,
		});
		expect(await sandbox.stat("/workspace/files/a.txt")).toEqual({
			isDirectory: false,
		});
		expect(await sandbox.exists("/workspace/files/a.txt")).toBe(true);
		expect(await sandbox.exists("/workspace/files/missing")).toBe(false);
		await expect(
			sandbox.readFile("/workspace/files/missing"),
		).rejects.toThrow();
		await expect(sandbox.stat("/workspace/files/missing")).rejects.toThrow();
	});

	test("host files and host env vars are invisible inside the container", async () => {
		const env = await run("env");
		expect(env.stdout).not.toContain(hostSecret);
		expect(env.stdout).not.toContain("RIVET_DOCKER_TEST_SECRET");
		expect(await sandbox.exists(join(hostDir, "secret.txt"))).toBe(false);
		expect(await sandbox.exists(hostDir)).toBe(false);
	});

	test("network none leaves only the loopback interface", async () => {
		const { sandbox: offline } = await start({ network: "none" });
		const result = await offline.exec("ls /sys/class/net", {
			cwd: offline.cwd,
		});
		expect(result.stdout.trim()).toBe("lo");
	});

	test("published ports bind to 127.0.0.1 only", async () => {
		const { id } = await start({ ports: [8080] });
		expect(await dockerPortAddress(id, 8080)).toMatch(/^127\.0\.0\.1:\d+$/);
	});

	test("a suspended sandbox keeps its files and a destroyed one is gone", async () => {
		const { provider, id, sandbox: first } = await start();
		await first.writeFile("/workspace/kept.txt", "kept");
		await provider.suspend?.(context, id);
		const resumed = await provider.connect(context, id);
		expect(
			Buffer.from(
				(await resumed?.readFile("/workspace/kept.txt")) ?? [],
			).toString(),
		).toBe("kept");
		await provider.destroy?.(context, id);
		expect(await provider.connect(context, id)).toBeUndefined();
	});
});

test("the docker provider rejects the host network", () => {
	expect(() => dockerProvider({ network: "host" })).toThrow();
});
