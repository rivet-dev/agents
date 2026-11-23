import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type AgentPlatformProviderOptions,
	agentPlatformProvider,
} from "../src/agent-platform.js";
import type { Sandbox, SandboxActorContext } from "../src/index.js";

const ENGINE = "projects/p/locations/us-central1/reasoningEngines/1";
const TEMPLATE = `${ENGINE}/sandboxEnvironmentTemplates/7`;
const context: SandboxActorContext = {
	actorId: "agent-platform-test",
	client: () => undefined,
};

type State =
	| "STATE_RUNNING"
	| "STATE_PAUSED"
	| "STATE_RESUMING"
	| "STATE_PROVISIONING";

/**
 * An in-memory Agent Platform API. `:execute` runs each command in a local
 * shell the way the shell sandbox's `/exec` server does.
 */
class FakeAgentPlatform {
	readonly sandboxes = new Map<string, { state: State }>();
	readonly creates: Record<string, unknown>[] = [];
	readonly requests: string[] = [];
	private nextId = 100;
	private readonly server: Server;
	url = "";

	constructor() {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((error: Error) => {
				res.writeHead(500).end(error.message);
			});
		});
	}

	async start() {
		await new Promise<void>((resolve) =>
			this.server.listen(0, "127.0.0.1", resolve),
		);
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		this.url = `http://127.0.0.1:${address.port}`;
	}

	close() {
		this.server.close();
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const send = (status: number, body: unknown) =>
			res
				.writeHead(status, { "content-type": "application/json" })
				.end(JSON.stringify(body));
		const fail = (status: number, code: string) =>
			send(status, { error: { code: status, status: code, message: code } });
		if (req.headers.authorization !== "Bearer test-token")
			return fail(401, "UNAUTHENTICATED");
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = chunks.length
			? JSON.parse(Buffer.concat(chunks).toString())
			: undefined;
		const path = decodeURIComponent((req.url ?? "").replace(/^\/v1\//, ""));
		const [name, method] = path.split(":");
		this.requests.push(`${req.method} ${method ?? ""}`.trim());

		if (req.method === "POST" && name === `${ENGINE}/sandboxEnvironments`) {
			this.creates.push(body);
			const sandbox = `${ENGINE}/sandboxEnvironments/${this.nextId++}`;
			this.sandboxes.set(sandbox, { state: "STATE_PROVISIONING" });
			return send(200, { name: `${sandbox}/operations/1`, done: false });
		}
		if (name.includes("/operations/")) {
			const sandbox = name.split("/operations/")[0];
			const entry = this.sandboxes.get(sandbox);
			if (entry) entry.state = "STATE_RUNNING";
			return send(200, {
				name,
				done: true,
				response: { name: sandbox, state: "STATE_RUNNING" },
			});
		}
		const sandbox = this.sandboxes.get(name);
		if (!sandbox) return fail(404, "NOT_FOUND");
		if (req.method === "GET") {
			const state = sandbox.state;
			// A resume finishes the next time the sandbox is read.
			if (state === "STATE_RESUMING") sandbox.state = "STATE_RUNNING";
			return send(200, { name, state });
		}
		if (req.method === "DELETE") {
			this.sandboxes.delete(name);
			return send(200, { name: `${name}/operations/2`, done: true });
		}
		if (method === "pause") {
			if (sandbox.state !== "STATE_RUNNING")
				return fail(400, "FAILED_PRECONDITION");
			sandbox.state = "STATE_PAUSED";
			return send(200, { name: `${name}/operations/3`, done: true });
		}
		if (method === "resume") {
			if (sandbox.state !== "STATE_PAUSED")
				return fail(400, "FAILED_PRECONDITION");
			sandbox.state = "STATE_RESUMING";
			return send(200, { name: `${name}/operations/4`, done: false });
		}
		if (method === "execute") {
			if (sandbox.state !== "STATE_RUNNING") return fail(503, "UNAVAILABLE");
			const inputs = (body.inputs as { mimeType: string; data: string }[]).map(
				(input) => ({
					mimeType: input.mimeType,
					data: Buffer.from(input.data, "base64").toString(),
				}),
			);
			const uri = inputs.find(
				(i) => i.mimeType === "application/x.sandbox-request-uri",
			);
			const port = inputs.find(
				(i) => i.mimeType === "application/x.sandbox-request-port",
			);
			const request = inputs.find((i) => i.mimeType === "application/json");
			if (uri?.data !== "/exec" || port?.data !== "8080" || !request)
				return fail(400, "INVALID_ARGUMENT");
			const { timeout } = JSON.parse(request.data);
			const result = await runLocally(JSON.parse(request.data));
			// A command killed at its timeout fails the request, as the real API does.
			if (result.returncode === -9 && timeout)
				return send(400, {
					error: {
						code: 400,
						status: "FAILED_PRECONDITION",
						message: `Execution Failed. Error: DEADLINE_EXCEEDED on URL \`https://sandbox.example/exec\`. Error Details: {"detail":"command exceeded ${timeout}s and was killed"}`,
					},
				});
			return send(200, {
				outputs: [
					{
						mimeType: "application/json",
						data: Buffer.from(JSON.stringify(result)).toString("base64"),
					},
				],
			});
		}
		return fail(400, "INVALID_ARGUMENT");
	}
}

function runLocally(request: {
	command: string;
	cwd?: string;
	timeout?: number;
}): Promise<{
	stdout: string;
	stderr: string;
	returncode: number;
	duration_ms: number;
}> {
	const started = Date.now();
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", request.command], {
			cwd: request.cwd,
			// Only the sandbox's own environment, not the test runner's.
			env: { PATH: process.env.PATH, HOME: request.cwd },
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => stdout.push(data));
		child.stderr.on("data", (data: Buffer) => stderr.push(data));
		const timer = request.timeout
			? setTimeout(() => child.kill("SIGKILL"), request.timeout * 1000)
			: undefined;
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
				returncode: code ?? (signal ? -9 : 1),
				duration_ms: Date.now() - started,
			});
		});
	});
}

describe("agent-platform provider", () => {
	const fake = new FakeAgentPlatform();
	let dir: string;
	let sandbox: Sandbox;
	const provider = (options: Partial<AgentPlatformProviderOptions> = {}) =>
		agentPlatformProvider({
			template: TEMPLATE,
			apiEndpoint: fake.url,
			auth: { getAccessToken: async () => "test-token" },
			cwd: dir,
			...options,
		});

	beforeAll(async () => {
		await fake.start();
		dir = await mkdtemp(join(tmpdir(), "agent-platform-"));
		const id = await provider().create(context);
		const connected = await provider().connect(context, id);
		if (!connected) throw new Error("new sandbox did not connect");
		sandbox = connected;
	});

	afterAll(async () => {
		fake.close();
		await rm(dir, { recursive: true, force: true });
	});

	test("rejects a template that is not a template resource name", () => {
		expect(() => agentPlatformProvider({ template: ENGINE })).toThrow(
			"sandboxEnvironmentTemplates",
		);
	});

	test("create sends the template, waits for the operation, and returns the sandbox name", async () => {
		expect(fake.creates[0]).toEqual({
			displayName: "rivet-agent-platform-test",
			sandboxEnvironmentTemplate: TEMPLATE,
		});
		const id = await provider({
			create: (c) => ({ ttl: "3600s", displayName: `custom-${c.actorId}` }),
		}).create(context);
		expect(id).toMatch(/^projects\/p\/.*\/sandboxEnvironments\/\d+$/);
		expect(fake.creates[1]).toEqual({
			displayName: "custom-agent-platform-test",
			sandboxEnvironmentTemplate: TEMPLATE,
			ttl: "3600s",
		});
	});

	test("suspend pauses, connect resumes, and destroy deletes", async () => {
		const id = await provider().create(context);
		await provider().suspend?.(context, id);
		expect(fake.sandboxes.get(id)?.state).toBe("STATE_PAUSED");
		// Pausing a paused sandbox is a failed precondition, which is ignored.
		await provider().suspend?.(context, id);
		expect(await provider().connect(context, id)).toBeDefined();
		expect(fake.sandboxes.get(id)?.state).toBe("STATE_RUNNING");
		expect(fake.requests).toContain("POST resume");
		await provider().destroy?.(context, id);
		expect(await provider().connect(context, id)).toBeUndefined();
		await provider().destroy?.(context, id);
		await provider().suspend?.(context, id);
	});

	test("exec returns stdout, stderr, the exit code, cwd, and env", async () => {
		await sandbox.mkdir(join(dir, "sub"));
		const chunks: string[] = [];
		const result = await sandbox.exec(
			'echo "$GREETING $NAME"; pwd; echo oops >&2; exit 3',
			{
				cwd: join(dir, "sub"),
				env: { GREETING: "hello", NAME: "it's me" },
				onData: (chunk) => chunks.push(Buffer.from(chunk).toString()),
			},
		);
		expect(result).toEqual({
			exitCode: 3,
			timedOut: false,
			stdout: `hello it's me\n${join(dir, "sub")}\n`,
			stderr: "oops\n",
		});
		expect(chunks.join("")).toBe(`${result.stdout}${result.stderr}`);
	});

	test("an invalid env variable name is rejected", async () => {
		await expect(
			sandbox.exec("true", { cwd: dir, env: { "A;B": "x" } }),
		).rejects.toThrow("invalid agent-platform env variable name");
	});

	test("a timeout reports timedOut and no exit code", async () => {
		const result = await sandbox.exec("echo before; sleep 30", {
			cwd: dir,
			timeoutMs: 500,
		});
		expect(result).toMatchObject({ exitCode: null, timedOut: true });
	});

	test("aborting ends the wait", async () => {
		const controller = new AbortController();
		const pending = sandbox.exec("sleep 2", {
			cwd: dir,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);
		await expect(pending).rejects.toThrow("aborted");
	});

	test("file operations, including names with quotes and spaces", async () => {
		const nested = join(dir, "files", "it's a dir");
		await sandbox.mkdir(nested);
		const file = join(nested, "a b.txt");
		await sandbox.writeFile(file, "héllo\n");
		expect(Buffer.from(await sandbox.readFile(file)).toString()).toBe(
			"héllo\n",
		);
		await sandbox.writeFile(join(nested, ".hidden"), "");
		expect(await sandbox.stat(nested)).toEqual({ isDirectory: true });
		expect(await sandbox.stat(file)).toEqual({ isDirectory: false });
		expect((await sandbox.readdir(nested)).sort()).toEqual([
			".hidden",
			"a b.txt",
		]);
		expect(await sandbox.exists(file)).toBe(true);
		expect(await sandbox.exists(join(nested, "missing"))).toBe(false);
		await expect(sandbox.stat(join(nested, "missing"))).rejects.toThrow(
			"no such file or directory",
		);
		await expect(sandbox.readFile(join(nested, "missing"))).rejects.toThrow(
			"readFile",
		);
	});

	test("large files are written in chunks and moved into place", async () => {
		const content = randomBytes(150 * 1024).toString("base64");
		const file = join(dir, "large.txt");
		await sandbox.writeFile(file, content);
		expect(Buffer.from(await sandbox.readFile(file)).toString()).toBe(content);
		expect(await sandbox.readdir(dir)).not.toContainEqual(
			expect.stringContaining(".rivet-"),
		);
	});
});
