import { randomUUID } from "node:crypto";
import { request } from "node:https";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

const API_URL = "https://api.agent37.com";
/** Commands are answered by the machine the sandbox runs on, which takes the key as `X-Agent37-Key`. */
const EXEC_URL = "https://sandbox.agent37.app";

/** Body of `POST /v1/instances`. See https://www.agent37.com/docs/agents-api/instances/create. */
export interface Agent37CreateOptions {
	/** Template name. Defaults to `agent37-base`, Debian with Node, Python, and git. */
	template?: string;
	type?: "default" | "vm" | "performance";
	region?: string;
	resources?: { cpu?: number; memory?: number; disk?: number };
	env?: Record<string, string>;
	metadata?: Record<string, string>;
	[key: string]: unknown;
}

export interface Agent37ProviderOptions {
	/** Defaults to `AGENT37_API_KEY`. */
	apiKey?: string;
	/** Body of `POST /v1/instances`, or a function that returns it for the owning Actor. */
	create?:
		| Agent37CreateOptions
		| ((
				c: SandboxActorContext,
		  ) => Agent37CreateOptions | Promise<Agent37CreateOptions>);
	/**
	 * Working directory inside the sandbox, created when the Actor connects.
	 * Defaults to the sandbox's mount path, the home directory its backups
	 * cover, which is `/home/node` on `agent37-base`.
	 */
	cwd?: string;
}

/** Runs an agent's file and shell tools in an Agent37 sandbox. The sandbox sleeps while the actor sleeps. */
export function agent37Provider(
	options: Agent37ProviderOptions = {},
): SandboxProvider {
	const cwd =
		options.cwd === undefined ? undefined : posix.normalize(options.cwd);
	if (cwd !== undefined && !posix.isAbsolute(cwd))
		throw new Error(`agent37 cwd must be an absolute path, received ${cwd}`);
	const apiKey = () => {
		const key = options.apiKey ?? process.env.AGENT37_API_KEY;
		if (!key) throw new Error("agent37 needs an API key. Set AGENT37_API_KEY.");
		return key;
	};
	const api = (method: string, path: string, body?: unknown) =>
		send(
			`${API_URL}${path}`,
			method,
			{ Authorization: `Bearer ${apiKey()}` },
			body,
		);
	return {
		name: "agent37",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: options.create;
			const response = await api("POST", "/v1/instances", {
				template: "agent37-base",
				...create,
				metadata: { rivet_actor_id: c.actorId, ...create?.metadata },
			});
			return json(response, "create").id as string;
		},
		connect: async (_c, id) => {
			const response = await api(
				"GET",
				`/v1/instances/${encodeURIComponent(id)}`,
			);
			if (response.status === 404) return undefined;
			const instance = json(response, "connect");
			if (instance.status === "deleting" || instance.status === "deleted")
				return undefined;
			// A sleeping sandbox wakes on its next command. A stopped one has to be started.
			if (instance.status === "stopped")
				json(
					await api("POST", `/v1/instances/${encodeURIComponent(id)}/start`),
					"start",
				);
			const sandbox = agent37Sandbox(
				apiKey(),
				id,
				cwd ?? (instance.mount_path as string),
			);
			if (cwd !== undefined) await sandbox.mkdir(cwd);
			return sandbox;
		},
		suspend: async (_c, id) => {
			// Sleep keeps memory and running processes and bills the disk alone.
			for (let attempt = 0; ; attempt++) {
				const response = await api(
					"POST",
					`/v1/instances/${encodeURIComponent(id)}/sleep`,
				);
				// 400 means the sandbox is not running, and 404 that it is gone. Neither has anything to release.
				if (response.status === 404 || response.status === 400) return;
				// 409 means another operation on the sandbox is still running.
				if (response.status === 409 && attempt < 5) {
					await delay(2_000);
					continue;
				}
				json(response, "sleep");
				return;
			}
		},
		destroy: async (_c, id) => {
			const response = await api(
				"DELETE",
				`/v1/instances/${encodeURIComponent(id)}`,
			);
			if (response.status !== 404) json(response, "delete");
		},
	};
}

interface ExecResponse {
	exit_code: number;
	stdout: string;
	stderr: string;
}

// Records the shell's pid so a kill can find the command's process tree. A
// kill that arrives before the pid is written leaves a marker the wrapper checks.
const EXEC_WRAPPER =
	'd=/tmp/.rivet-exec; mkdir -p $d && echo $$ > "$d/$1"; if [ -f "$d/$1.kill" ]; then rm -f "$d/$1" "$d/$1.kill"; exit 137; fi; /bin/sh -c "$2"; s=$?; rm -f "$d/$1"; exit $s';

// Stops each process before reading its children so none can fork past the kill.
const KILL_TREE =
	't() { kill -STOP "$1" 2>/dev/null; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do t "$c"; done; kill -KILL "$1" 2>/dev/null; }; d=/tmp/.rivet-exec; mkdir -p $d && touch "$d/$1.kill"; if [ -f "$d/$1" ]; then t "$(cat "$d/$1")"; rm -f "$d/$1" "$d/$1.kill"; fi';

/** Each exec answer carries at most 512 KB of stdout, so files are read in blocks that stay under it as base64. */
const READ_BLOCK_BYTES = 256 * 1024;
/** An exec request is capped at 1 MB, so files are written in blocks that stay under it as base64. */
const WRITE_BLOCK_BYTES = 512 * 1024;

function agent37Sandbox(apiKey: string, id: string, cwd: string): Sandbox {
	/** Runs a script as root. Commands run as root because Agent37 images have no sudo. */
	const sh = async (script: string, args: string[] = []) => {
		const command = args.length
			? `set -- ${args.map(quote).join(" ")}; ${script}`
			: script;
		// The name makes a resend safe: the sandbox answers it with the first run's result.
		const body = { command, user: "root", name: randomUUID() };
		const url = `${EXEC_URL}/v1/instances/${encodeURIComponent(id)}/exec`;
		for (let attempt = 0; ; attempt++) {
			const retry = attempt < 5;
			let response: HttpResponse;
			try {
				response = await send(url, "POST", { "X-Agent37-Key": apiKey }, body);
			} catch (error) {
				if (!retry) throw error;
				await delay(1_000 * (attempt + 1));
				continue;
			}
			// 503 and 409 mean the command was refused before it started, for example while the sandbox wakes.
			if ((response.status === 503 || response.status === 409) && retry) {
				await delay(1_000 * (attempt + 1));
				continue;
			}
			return json(response, "exec") as unknown as ExecResponse;
		}
	};
	const check = async (
		operation: string,
		path: string,
		script: string,
		args: string[] = [],
	) => {
		const result = await sh(script, [path, ...args]);
		if (result.exit_code !== 0)
			throw new Error(
				`agent37 ${operation} ${path} failed: ${result.stderr.trim() || `exit code ${result.exit_code}`}`,
			);
		return result.stdout;
	};
	return {
		cwd,
		exec: (command, options) => exec(sh, command, options),
		readFile: async (path) => {
			const blocks: Buffer[] = [];
			for (let block = 0; ; block++) {
				const stdout = await check(
					"readFile",
					path,
					'if [ ! -f "$1" ]; then echo "no such file" >&2; exit 1; fi; dd if="$1" bs=$2 skip=$3 count=1 iflag=fullblock status=none | base64',
					[String(READ_BLOCK_BYTES), String(block)],
				);
				const data = Buffer.from(stdout, "base64");
				blocks.push(data);
				if (data.length < READ_BLOCK_BYTES)
					return new Uint8Array(Buffer.concat(blocks));
			}
		},
		writeFile: async (path, content) => {
			const data = Buffer.from(content);
			if (data.length <= WRITE_BLOCK_BYTES) {
				await check("writeFile", path, 'printf %s "$2" | base64 -d > "$1"', [
					data.toString("base64"),
				]);
				return;
			}
			// Larger content is staged in blocks, then copied in one step.
			const staged = `/tmp/.rivet-write-${randomUUID()}`;
			try {
				for (let offset = 0; offset < data.length; offset += WRITE_BLOCK_BYTES)
					await check(
						"writeFile",
						staged,
						'printf %s "$2" | base64 -d >> "$1"',
						[
							data
								.subarray(offset, offset + WRITE_BLOCK_BYTES)
								.toString("base64"),
						],
					);
				await check("writeFile", path, 'cat -- "$2" > "$1"', [staged]);
			} finally {
				await sh('rm -f -- "$1"', [staged]).catch(() => {});
			}
		},
		mkdir: async (path) => {
			await check("mkdir", path, 'mkdir -p -- "$1"');
		},
		stat: async (path) => ({
			isDirectory:
				(
					await check(
						"stat",
						path,
						'if [ -d "$1" ]; then echo d; elif [ -e "$1" ]; then echo f; else echo "no such file or directory" >&2; exit 1; fi',
					)
				).trim() === "d",
		}),
		readdir: async (path) =>
			(
				await check(
					"readdir",
					path,
					'cd -- "$1" || exit 1; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done',
				)
			)
				.split("\0")
				.filter(Boolean),
		exists: async (path) => (await sh('[ -e "$1" ]', [path])).exit_code === 0,
	};
}

async function exec(
	sh: (script: string, args?: string[]) => Promise<ExecResponse>,
	command: string,
	options: SandboxExecOptions,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	const token = randomUUID();
	let script = 'cd -- "$3" || exit 1; ';
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			throw new Error(`invalid agent37 env variable name ${key}`);
		script += `export ${key}=${quote(value)}; `;
	}
	script += EXEC_WRAPPER;
	let ended: "aborted" | "timeout" | undefined;
	const kill = (reason: "aborted" | "timeout") => {
		if (ended) return;
		ended = reason;
		sh(KILL_TREE, [token]).catch(() => {});
	};
	const abort = () => kill("aborted");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = options.timeoutMs
		? setTimeout(() => kill("timeout"), options.timeoutMs)
		: undefined;
	try {
		const result = await sh(script, [token, command, options.cwd]);
		if (ended === "aborted") throw new Error("aborted");
		// Agent37 returns stdout and stderr once the command ends.
		if (result.stdout) options.onData?.(Buffer.from(result.stdout));
		if (result.stderr) options.onData?.(Buffer.from(result.stderr));
		return {
			exitCode: ended === "timeout" ? null : result.exit_code,
			timedOut: ended === "timeout",
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}

interface HttpResponse {
	status: number;
	text: string;
	method: string;
	url: string;
}

/**
 * Sends a JSON request over `node:https`. `fetch` gives up on a response
 * after 300 seconds, and a command can run for up to 15 minutes before it
 * answers, so the socket also keeps itself alive while it waits.
 */
function send(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<HttpResponse> {
	const payload = body === undefined ? undefined : JSON.stringify(body);
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				method,
				headers: {
					...headers,
					...(payload === undefined
						? {}
						: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(payload),
							}),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						text: Buffer.concat(chunks).toString(),
						method,
						url,
					}),
				);
				res.on("error", reject);
			},
		);
		req.on("socket", (socket) => socket.setKeepAlive(true, 15_000));
		req.on("error", reject);
		req.end(payload);
	});
}

function json(
	response: HttpResponse,
	operation: string,
): Record<string, unknown> {
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			`agent37 ${operation} failed with ${response.status}: ${response.text}`,
		);
	return JSON.parse(response.text) as Record<string, unknown>;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
