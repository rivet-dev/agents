import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import type { Sandbox, SandboxActorContext } from "../src/index.js";
import { Kosa8ApiError, kosa8Provider } from "../src/kosa8.js";

const context: SandboxActorContext = {
	actorId: "kosa8-provider-test",
	client: () => undefined,
};

/**
 * An in-memory kosa8 Cloud API behind `fetch`: sandbox create, get, sleep and
 * delete, the files API (which reaches `/workspace` only, at most 8 MiB a
 * request, like kosa8's), and the streamed NDJSON exec. Each exec runs with
 * the local `/bin/sh` in a temporary directory that stands in for the
 * sandbox's `/workspace` and `/tmp`, so the provider's own scripts run.
 */
class FakeKosa8 {
	readonly sandboxes = new Map<string, { state: string; body: unknown }>();
	readonly requests: { method: string; path: string; body?: unknown }[] = [];
	readonly execs: { cmd: string[]; env?: string[] }[] = [];
	maxFileBytes = 8 * 1024 * 1024;
	private seq = 0;
	private readonly running = new Map<string, ChildProcess>();

	constructor(readonly root: string) {}

	private local(path: string): string {
		return join(this.root, path);
	}

	private toLocal(text: string): string {
		return text.replace(
			/(?<![\w./-])\/(workspace|tmp)(?=\/|\b)/g,
			(_m, dir) => `${this.root}/${dir}`,
		);
	}

	private fromLocal(data: Buffer): Buffer {
		return Buffer.from(
			data.toString("latin1").replaceAll(`${this.root}/`, "/"),
			"latin1",
		);
	}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-key");
		const raw = init?.body;
		const json =
			headers.get("content-type") === "application/json" &&
			typeof raw === "string"
				? JSON.parse(raw)
				: undefined;
		this.requests.push({ method, path: url.pathname, body: json });
		const parts = url.pathname.split("/").filter(Boolean);
		if (parts.length === 2 && method === "POST") {
			const id = `sb_${++this.seq}`;
			this.sandboxes.set(id, { state: "running", body: json });
			return Response.json(
				{ sandbox: { id, state: "running" } },
				{ status: 201 },
			);
		}
		const box = this.sandboxes.get(parts[2] ?? "");
		if (!box || box.state === "deleted")
			return error(404, "not_found", "no such sandbox");
		const rest = parts.slice(3).join("/");
		if (rest === "" && method === "GET")
			return Response.json({ sandbox: { id: parts[2], state: box.state } });
		if (rest === "" && method === "DELETE") {
			box.state = "deleted";
			return Response.json({ ok: true });
		}
		if (rest === "sleep") {
			box.state = "sleeping";
			return Response.json({ sandbox: { id: parts[2], state: "sleeping" } });
		}
		if (rest === "exec") return this.exec(json, init?.signal ?? undefined);
		if (rest.startsWith("files")) {
			const path = url.searchParams.get("path") ?? json?.path;
			if (!path?.startsWith("/workspace"))
				return error(400, "invalid_path", "path must be a workspace path");
			if (rest === "files/mkdir") {
				await mkdir(this.local(path), { recursive: true });
				return Response.json({ file: { path } });
			}
			if (method === "PUT") {
				const data = Buffer.from(raw as Uint8Array);
				if (data.length > this.maxFileBytes)
					return error(413, "too_large", "too large");
				try {
					await writeFile(this.local(path), data);
				} catch {
					return error(
						404,
						"not_found",
						`could not write ${path}: no such directory`,
					);
				}
				return Response.json({ file: { path, size: data.length } });
			}
			try {
				const data = await readFile(this.local(path));
				if (data.length > this.maxFileBytes)
					return error(413, "too_large", "too large");
				return new Response(data);
			} catch {
				return error(404, "not_found", `could not read ${path}: no such file`);
			}
		}
		return error(404, "not_found", "no such route");
	};

	private exec(
		body: { cmd: string[]; env?: string[]; stream?: boolean },
		signal?: AbortSignal,
	) {
		this.execs.push({ cmd: body.cmd, env: body.env });
		expect(body.stream).toBe(true);
		for (const arg of body.cmd)
			expect(
				Buffer.byteLength(arg),
				"kosa8 caps each exec argument at 8 KiB",
			).toBeLessThanOrEqual(8192);
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		for (const item of body.env ?? []) {
			const at = item.indexOf("=");
			env[item.slice(0, at)] = item.slice(at + 1);
		}
		const argv = body.cmd.map((arg) => this.toLocal(arg));
		// kill on macOS has no /proc to walk, so the fake ends the token's process itself.
		if (body.cmd[2]?.includes('touch "$d/$1.kill"')) {
			const pid = this.running.get(body.cmd[4] ?? "")?.pid;
			if (pid) process.kill(-pid, "SIGKILL");
		}
		const child = spawn(argv[0] as string, argv.slice(1), {
			cwd: join(this.root, "workspace"),
			env,
			// Its own process group, so a kill reaches what the command started.
			detached: true,
		});
		if (body.cmd[2]?.includes('echo $$ > "$d/$1"'))
			this.running.set(body.cmd[4] ?? "", child);
		signal?.addEventListener("abort", () => {
			if (child.pid) process.kill(-child.pid, "SIGKILL");
		});
		const encoder = new TextEncoder();
		const frame = (value: unknown) =>
			encoder.encode(`${JSON.stringify(value)}\n`);
		const fromLocal = (data: Buffer) => this.fromLocal(data);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					frame({ stream: "stdout", data: "", heartbeat: true }),
				);
				child.stdout.on("data", (data: Buffer) =>
					controller.enqueue(
						frame({
							stream: "stdout",
							data: fromLocal(data).toString("base64"),
						}),
					),
				);
				child.stderr.on("data", (data: Buffer) =>
					controller.enqueue(
						frame({
							stream: "stderr",
							data: fromLocal(data).toString("base64"),
						}),
					),
				);
				child.on("close", (code) => {
					controller.enqueue(frame({ done: true, exit: code }));
					controller.close();
				});
			},
		});
		return new Response(stream, {
			headers: { "content-type": "application/x-ndjson" },
		});
	}
}

function error(status: number, code: string, message: string) {
	return Response.json({ error: code, message }, { status });
}

describe.skipIf(process.platform === "win32")(
	"kosa8 provider (fake API)",
	() => {
		let root: string;
		let fake: FakeKosa8;
		let provider: ReturnType<typeof kosa8Provider>;
		let sandbox: Sandbox;
		let id: string;

		beforeEach(async () => {
			root = await mkdtemp(join(tmpdir(), "kosa8-provider-"));
			await mkdir(join(root, "workspace"), { recursive: true });
			await mkdir(join(root, "tmp"), { recursive: true });
			fake = new FakeKosa8(root);
			provider = kosa8Provider({
				apiKey: "test-key",
				fetch: fake.fetch,
				create: { image: "node:22", size: "2x4", env: { GREETING: "hello" } },
			});
			id = await provider.create(context);
			const connected = await provider.connect(context, id);
			if (!connected) throw new Error("new sandbox did not connect");
			sandbox = connected;
		});

		afterEach(async () => {
			await rm(root, { recursive: true, force: true });
		});

		test("create sends the create options", () => {
			expect(fake.sandboxes.get(id)?.body).toEqual({
				persistent: true,
				image: "node:22",
				size: "2x4",
				env: { GREETING: "hello" },
			});
			expect(sandbox.cwd).toBe("/workspace");
		});

		test("exec returns separate stdout and stderr, the exit code, cwd, and env", async () => {
			await sandbox.mkdir("/workspace/sub");
			const result = await sandbox.exec(
				'echo "$NAME"; pwd; echo oops >&2; exit 3',
				{
					cwd: "/workspace/sub",
					env: { NAME: "world" },
				},
			);
			expect(result).toEqual({
				exitCode: 3,
				timedOut: false,
				stdout: "world\n/workspace/sub\n",
				stderr: "oops\n",
			});
			// The env rides in the exec's own field, never in the command.
			expect(fake.execs.at(-1)?.env).toEqual(["NAME=world"]);
			expect(fake.execs.at(-1)?.cmd.join(" ")).not.toContain("world");
		});

		test("rejects env names kosa8 would refuse", async () => {
			await expect(
				sandbox.exec("true", { cwd: "/workspace", env: { "bad-name": "x" } }),
			).rejects.toThrow(/env variable name/);
		});

		test("output streams through onData", async () => {
			const chunks: string[] = [];
			await sandbox.exec("echo one; echo two >&2", {
				cwd: "/workspace",
				onData: (chunk) => chunks.push(Buffer.from(chunk).toString()),
			});
			expect(chunks.join("")).toContain("one\n");
			expect(chunks.join("")).toContain("two\n");
		});

		test("a timeout kills the command and keeps its output", async () => {
			const result = await sandbox.exec("echo started; sleep 30", {
				cwd: "/workspace",
				timeoutMs: 300,
			});
			expect(result.timedOut).toBe(true);
			expect(result.exitCode).toBeNull();
			expect(result.stdout).toBe("started\n");
		});

		test("aborting kills the command and rejects", async () => {
			const controller = new AbortController();
			const pending = sandbox.exec("sleep 30", {
				cwd: "/workspace",
				signal: controller.signal,
			});
			setTimeout(() => controller.abort(), 200);
			await expect(pending).rejects.toThrow("aborted");
			const kill = fake.execs.find((e) =>
				e.cmd[2]?.includes('touch "$d/$1.kill"'),
			);
			expect(kill?.cmd[4]).toBe(
				fake.execs.find((e) => e.cmd[5] === "/workspace")?.cmd[4],
			);
		});

		test("a command longer than one exec argument is staged as a script", async () => {
			const long = "x".repeat(20_000);
			const result = await sandbox.exec(`printf %s '${long}' | wc -c`, {
				cwd: "/workspace",
			});
			expect(result.stdout.trim()).toBe("20000");
			expect(result.exitCode).toBe(0);
		});

		test("files under /workspace round-trip through the files API", async () => {
			await sandbox.mkdir("/workspace/a/b");
			await sandbox.writeFile("/workspace/a/b/note.txt", "héllo\n");
			expect(
				Buffer.from(
					await sandbox.readFile("/workspace/a/b/note.txt"),
				).toString(),
			).toBe("héllo\n");
			expect(await sandbox.exists("/workspace/a/b/note.txt")).toBe(true);
			expect(await sandbox.exists("/workspace/a/b/missing")).toBe(false);
			expect(await sandbox.stat("/workspace/a")).toEqual({ isDirectory: true });
			expect(await sandbox.stat("/workspace/a/b/note.txt")).toEqual({
				isDirectory: false,
			});
			expect((await sandbox.readdir("/workspace/a/b")).sort()).toEqual([
				"note.txt",
			]);
			await expect(sandbox.stat("/workspace/none")).rejects.toThrow(
				/no such file/,
			);
			expect(
				fake.requests.some(
					(r) => r.method === "PUT" && r.path.endsWith("/files"),
				),
			).toBe(true);
		});

		test("paths outside /workspace and large files go over exec", async () => {
			await sandbox.mkdir("/tmp/out");
			await sandbox.writeFile("/tmp/out/x.txt", "outside");
			expect(await readFile(join(root, "tmp/out/x.txt"), "utf8")).toBe(
				"outside",
			);
			expect(
				Buffer.from(await sandbox.readFile("/tmp/out/x.txt")).toString(),
			).toBe("outside");

			// Above the files API's 8 MiB request limit: staged in parts, read back over exec.
			const big = "y".repeat(9 * 1024 * 1024);
			await sandbox.writeFile("/workspace/big.txt", big);
			expect(await readFile(join(root, "workspace/big.txt"), "utf8")).toBe(big);
			expect(
				Buffer.from(await sandbox.readFile("/workspace/big.txt")).toString(),
			).toBe(big);
			expect(fake.execs.some((e) => e.cmd.join(" ").includes("cat --"))).toBe(
				true,
			);
		});

		test("a missing file rejects", async () => {
			await expect(sandbox.readFile("/workspace/nope.txt")).rejects.toThrow(
				/no such file/,
			);
		});

		test("suspend sleeps the sandbox, connect after delete reports it gone", async () => {
			await provider.suspend?.(context, id);
			expect(fake.sandboxes.get(id)?.state).toBe("sleeping");
			await provider.destroy?.(context, id);
			expect(fake.sandboxes.get(id)?.state).toBe("deleted");
			expect(await provider.connect(context, id)).toBeUndefined();
			// Destroying twice is not an error.
			await provider.destroy?.(context, id);
		});

		test("an API refusal carries kosa8's status and code", async () => {
			const box = fake.sandboxes.get(id);
			if (box) box.state = "deleted";
			const error = await sandbox
				.readFile("/workspace/x")
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(Kosa8ApiError);
			expect(error).toMatchObject({ status: 404, code: "not_found" });
		});
	},
);

test("a missing API key fails with a pointer to KOSA8_API_KEY", async () => {
	const saved = process.env.KOSA8_API_KEY;
	delete process.env.KOSA8_API_KEY;
	try {
		await expect(kosa8Provider().create(context)).rejects.toThrow(
			/KOSA8_API_KEY/,
		);
	} finally {
		if (saved !== undefined) process.env.KOSA8_API_KEY = saved;
	}
});

describe.skipIf(!process.env.KOSA8_API_KEY)("kosa8 provider (live)", () => {
	const provider = kosa8Provider({ create: { ttl_s: 900 } });
	let id: string | undefined;

	afterAll(async () => {
		if (id) await provider.destroy?.(context, id);
	});

	test("runs commands and files in a real sandbox", async () => {
		id = await provider.create(context);
		const sandbox = await provider.connect(context, id);
		if (!sandbox) throw new Error("new sandbox did not connect");
		const marker = randomUUID();
		await sandbox.mkdir("/workspace/live/sub");
		const result = await sandbox.exec(
			`echo ${marker}; pwd; echo err >&2; exit 4`,
			{
				cwd: "/workspace/live/sub",
				env: { LIVE: "1" },
			},
		);
		expect(result).toEqual({
			exitCode: 4,
			timedOut: false,
			stdout: `${marker}\n/workspace/live/sub\n`,
			stderr: "err\n",
		});
		const timedOut = await sandbox.exec("echo a; sleep 30", {
			cwd: sandbox.cwd,
			timeoutMs: 2000,
		});
		expect(timedOut).toMatchObject({
			timedOut: true,
			exitCode: null,
			stdout: "a\n",
		});
		const controller = new AbortController();
		const pending = sandbox.exec("sleep 60", {
			cwd: sandbox.cwd,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 1000);
		await expect(pending).rejects.toThrow("aborted");
		expect(
			(await sandbox.exec("ps -o args 2>/dev/null || ps", { cwd: sandbox.cwd }))
				.stdout,
		).not.toContain("sleep 60");
		await sandbox.writeFile("/workspace/live/f.txt", "kosa8");
		expect(
			Buffer.from(await sandbox.readFile("/workspace/live/f.txt")).toString(),
		).toBe("kosa8");
		await sandbox.mkdir("/tmp/live");
		await sandbox.writeFile("/tmp/live/g.txt", "outside");
		expect(
			Buffer.from(await sandbox.readFile("/tmp/live/g.txt")).toString(),
		).toBe("outside");
		const long = "z".repeat(20_000);
		expect(
			(
				await sandbox.exec(`printf %s '${long}' | wc -c`, { cwd: sandbox.cwd })
			).stdout.trim(),
		).toBe("20000");
		expect(await sandbox.readdir("/workspace/live")).toEqual(
			expect.arrayContaining(["f.txt", "sub"]),
		);
		await provider.suspend?.(context, id);
		const woken = await provider.connect(context, id);
		if (!woken) throw new Error("the sandbox did not wake");
		expect(
			Buffer.from(await woken.readFile("/workspace/live/f.txt")).toString(),
		).toBe("kosa8");
	}, 300_000);
});
