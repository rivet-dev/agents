import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	CreateMicrovmAuthTokenCommand,
	GetMicrovmCommand,
	type LambdaMicrovmsClient,
	type MicrovmState,
	ResumeMicrovmCommand,
	RunMicrovmCommand,
	type RunMicrovmRequest,
	SuspendMicrovmCommand,
	TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sandbox, SandboxActorContext } from "../src/index.js";
import { lambdaMicrovmsProvider } from "../src/lambda-microvms.js";

// The MicroVM side runs a real Sandbox Agent server. Set SANDBOX_AGENT_BIN to
// a `sandbox-agent` binary to run these tests.
const binary = process.env.SANDBOX_AGENT_BIN;
const context: SandboxActorContext = {
	actorId: "lambda-microvms-test",
	client: () => undefined,
};

function awsError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

/** An in-memory Lambda MicroVMs control plane whose MicroVMs all point at one local server. */
class FakeMicrovms {
	readonly vms = new Map<string, { state: MicrovmState; endpoint?: string }>();
	readonly runs: RunMicrovmRequest[] = [];
	readonly tokens: unknown[] = [];
	readonly calls: string[] = [];
	constructor(private readonly endpoint: string) {}

	client(): LambdaMicrovmsClient {
		return {
			config: { region: async () => "us-west-2" },
			send: async (command: { input: Record<string, unknown> }) =>
				this.send(command),
		} as unknown as LambdaMicrovmsClient;
	}

	private async send(command: { input: Record<string, unknown> }) {
		const id = command.input.microvmIdentifier as string;
		const vm = this.vms.get(id);
		if (command instanceof RunMicrovmCommand) {
			this.runs.push(command.input);
			const microvmId = `mvm-${randomUUID()}`;
			this.vms.set(microvmId, { state: "RUNNING" });
			return { microvmId, state: "PENDING", endpoint: this.endpoint };
		}
		this.calls.push(`${command.constructor.name} ${id}`);
		if (!vm) throw awsError("ResourceNotFoundException");
		if (command instanceof GetMicrovmCommand)
			return {
				microvmId: id,
				state: vm.state,
				endpoint: vm.endpoint ?? this.endpoint,
			};
		if (command instanceof CreateMicrovmAuthTokenCommand) {
			this.tokens.push(command.input);
			return { authToken: { "X-aws-proxy-auth": "token" } };
		}
		if (command instanceof SuspendMicrovmCommand) {
			if (vm.state !== "RUNNING") throw awsError("ConflictException");
			vm.state = "SUSPENDED";
			return {};
		}
		if (command instanceof ResumeMicrovmCommand) {
			if (vm.state !== "SUSPENDED") throw awsError("ConflictException");
			vm.state = "RUNNING";
			return {};
		}
		if (command instanceof TerminateMicrovmCommand) {
			vm.state = "TERMINATED";
			return {};
		}
		throw new Error(`unexpected command ${command.constructor.name}`);
	}
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise((resolve) => server.close(resolve));
	if (!address || typeof address === "string") throw new Error("no port");
	return address.port;
}

/**
 * Stands in for the MicroVM endpoint, which rejects a request without a valid
 * token for the port it names.
 */
async function startEndpointProxy(port: number): Promise<Server> {
	const proxy = createHttpServer(async (req, res) => {
		if (
			req.headers["x-aws-proxy-auth"] !== "token" ||
			req.headers["x-aws-proxy-port"] !== String(port)
		) {
			res.writeHead(403).end();
			return;
		}
		const body: Buffer[] = [];
		for await (const chunk of req) body.push(chunk as Buffer);
		const contentType = req.headers["content-type"];
		// The endpoint answers 502 until the server in the MicroVM is up.
		const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`, {
			method: req.method,
			headers: contentType ? { "content-type": contentType } : {},
			body: body.length ? Buffer.concat(body) : undefined,
		}).catch(() => undefined);
		if (!upstream) {
			res.writeHead(502).end();
			return;
		}
		res.writeHead(upstream.status, {
			"content-type": upstream.headers.get("content-type") ?? "",
		});
		res.end(Buffer.from(await upstream.arrayBuffer()));
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	return proxy;
}

describe.skipIf(!binary)("lambda-microvms provider", () => {
	let server: ChildProcess;
	let proxy: Server;
	let home: string;
	let fake: FakeMicrovms;
	let sandbox: Sandbox;
	let port: number;
	const provider = () =>
		lambdaMicrovmsProvider({
			client: fake.client(),
			create: { imageIdentifier: "sandbox-agent" },
			port,
			cwd: home,
		});

	beforeAll(async () => {
		port = await freePort();
		home = await mkdtemp(join(tmpdir(), "lambda-microvms-"));
		server = spawn(
			binary as string,
			[
				"server",
				"--no-token",
				"--no-telemetry",
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
			],
			{ env: { ...process.env, HOME: home }, stdio: "ignore" },
		);
		proxy = await startEndpointProxy(port);
		const address = proxy.address();
		if (!address || typeof address === "string")
			throw new Error("no proxy port");
		fake = new FakeMicrovms(`http://127.0.0.1:${address.port}`);
		const id = await provider().create(context);
		const connected = await provider().connect(context, id);
		if (!connected) throw new Error("new MicroVM did not connect");
		sandbox = connected;
	});

	afterAll(async () => {
		proxy?.close();
		server?.kill();
		await rm(home, { recursive: true, force: true });
	});

	test("create runs the image with an HTTP ingress connector in the client's Region", async () => {
		expect(fake.runs[0]).toEqual({
			imageIdentifier: "sandbox-agent",
			ingressNetworkConnectors: [
				"arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:HTTP_INGRESS",
			],
			maximumDurationInSeconds: 28_800,
			idlePolicy: {
				autoResumeEnabled: true,
				maxIdleDurationSeconds: 900,
				suspendedDurationSeconds: 28_800,
			},
		});
		const custom = lambdaMicrovmsProvider({
			client: fake.client(),
			create: (c) => ({
				imageIdentifier: `image-${c.actorId}`,
				maximumDurationInSeconds: 600,
			}),
		});
		await custom.create(context);
		expect(fake.runs[1]).toMatchObject({
			imageIdentifier: "image-lambda-microvms-test",
			maximumDurationInSeconds: 600,
		});
	});

	test("the auth token covers only the Sandbox Agent port and is reused", () => {
		expect(fake.tokens).toEqual([
			{
				microvmIdentifier: expect.any(String),
				expirationInMinutes: 60,
				allowedPorts: [{ port }],
			},
		]);
	});

	test("suspend, resume on connect, and destroy", async () => {
		const id = await provider().create(context);
		await provider().suspend?.(context, id);
		expect(fake.vms.get(id)?.state).toBe("SUSPENDED");
		// Suspending twice is a conflict, which the provider ignores.
		await provider().suspend?.(context, id);
		expect(await provider().connect(context, id)).toBeDefined();
		expect(fake.calls).toContain(`ResumeMicrovmCommand ${id}`);
		expect(fake.vms.get(id)?.state).toBe("RUNNING");
		await provider().destroy?.(context, id);
		expect(await provider().connect(context, id)).toBeUndefined();
	});

	test("a missing MicroVM connects as undefined and destroys without an error", async () => {
		expect(await provider().connect(context, "mvm-missing")).toBeUndefined();
		await provider().destroy?.(context, "mvm-missing");
		await provider().suspend?.(context, "mvm-missing");
	});

	test("connect returns undefined when the MicroVM is terminated before it answers", async () => {
		const id = await provider().create(context);
		const vm = fake.vms.get(id);
		if (!vm) throw new Error("no MicroVM");
		// Nothing listens here, so the health check never passes.
		vm.endpoint = `http://127.0.0.1:${await freePort()}`;
		setTimeout(() => {
			vm.state = "TERMINATED";
		}, 1_000);
		expect(await provider().connect(context, id)).toBeUndefined();
	});

	test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
		await sandbox.mkdir(join(home, "sub"));
		const result = await sandbox.exec(
			'echo "hello $NAME"; pwd; echo oops >&2; exit 3',
			{ cwd: join(home, "sub"), env: { NAME: "world" } },
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: `hello world\n${join(home, "sub")}\n`,
			stderr: "oops\n",
		});
	});

	test("output streams before the command ends, and aborting kills its children", async () => {
		const controller = new AbortController();
		const marker = `stream-${randomUUID()}`;
		const pidFile = join(home, `${marker}.pid`);
		let streamed: (chunk: string) => void = () => {};
		const firstChunk = new Promise<string>((resolve) => {
			streamed = resolve;
		});
		const pending = sandbox.exec(
			`sleep 300 & echo $! > ${pidFile}; echo ${marker}; wait`,
			{
				cwd: home,
				signal: controller.signal,
				onData: (chunk) => streamed(Buffer.from(chunk).toString()),
			},
		);
		expect(await firstChunk).toContain(marker);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		const child = Buffer.from(await sandbox.readFile(pidFile))
			.toString()
			.trim();
		await delay(200);
		expect(child).toMatch(/^\d+$/);
		// A killed child whose parent is gone can stay a zombie.
		const state = await sandbox.exec(
			`grep '^State' /proc/${child}/status || echo gone`,
			{ cwd: home },
		);
		expect(state.stdout).toMatch(/zombie|gone/);
	});

	test("a timeout ends the command and reports timedOut", async () => {
		const started = Date.now();
		const result = await sandbox.exec("echo before; sleep 300", {
			cwd: home,
			timeoutMs: 500,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result).toMatchObject({
			exitCode: null,
			timedOut: true,
			stdout: "before\n",
		});
	});

	test("file operations", async () => {
		const dir = join(home, "files", "nested");
		await sandbox.mkdir(dir);
		await sandbox.writeFile(join(dir, "a.txt"), "héllo\n");
		expect(
			Buffer.from(await sandbox.readFile(join(dir, "a.txt"))).toString(),
		).toBe("héllo\n");
		expect(await sandbox.stat(dir)).toEqual({ isDirectory: true });
		expect(await sandbox.stat(join(dir, "a.txt"))).toEqual({
			isDirectory: false,
		});
		expect(await sandbox.readdir(dir)).toEqual(["a.txt"]);
		expect(await sandbox.exists(join(dir, "a.txt"))).toBe(true);
		expect(await sandbox.exists(join(dir, "missing"))).toBe(false);
		await expect(sandbox.readFile(join(dir, "missing"))).rejects.toThrow(
			"path not found",
		);
	});
});
