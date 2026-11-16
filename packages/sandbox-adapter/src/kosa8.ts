import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

/** Options for `POST /v1/sandboxes`. See https://kosa8.com/docs for every field. */
export interface Kosa8CreateOptions {
	/** Template key, or a kosa8 Store item. Defaults to the organization's default template. */
	template?: string;
	/** An OCI image to boot instead of a template, such as `node:22`. */
	image?: string;
	/** vCPU x GiB. */
	size?: "2x4" | "4x8" | "8x16" | "16x32";
	/** `us`, `eu`, or a region id. Defaults to the region nearest the caller. */
	region?: string;
	/** Idle seconds before kosa8 puts the sandbox to sleep; 0 never. */
	sleep_after_s?: number;
	/** Delete the sandbox this many seconds after it is created. */
	ttl_s?: number;
	/** Run every command in one long-lived container. */
	persistent?: boolean;
	/** Environment variables kept on the sandbox's host and given to every command. */
	env?: Record<string, string>;
	/** A label; `GET /v1/sandboxes?name=` finds it. */
	name?: string;
	/** Any other field of the create request. */
	[field: string]: unknown;
}

export interface Kosa8ProviderOptions {
	/** Defaults to `KOSA8_API_KEY`. */
	apiKey?: string;
	/** Defaults to `KOSA8_API_URL`, then `https://api.kosa8.com`. Point it at a self-hosted kosa8 Cloud. */
	baseUrl?: string;
	/** Options for the create request, or a function that returns them for the owning Actor. */
	create?:
		| Kosa8CreateOptions
		| ((
				c: SandboxActorContext,
		  ) => Kosa8CreateOptions | Promise<Kosa8CreateOptions>);
	/** Working directory inside the sandbox, created when the Actor connects. Defaults to `/workspace`. */
	cwd?: string;
	/** How long `connect` waits for a sandbox that is still booting. Defaults to 5 minutes. */
	readyTimeoutMs?: number;
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
}

/** A refusal from the kosa8 API. `code` is kosa8's stable error code, such as `payment_required`. */
export class Kosa8ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | undefined,
	) {
		super(message);
		this.name = "Kosa8ApiError";
	}
}

const DEFAULT_BASE_URL = "https://api.kosa8.com";
/** The directory kosa8's files API can reach. */
const FILES_ROOT = "/workspace";
/** The files API moves at most 8 MiB a request; leave room for the request itself. */
const FILE_PART_BYTES = 8 * 1024 * 1024 - 64 * 1024;
/** kosa8 caps each exec argument at 8 KiB. Longer commands are staged as a script. */
const MAX_INLINE_COMMAND_BYTES = 8 * 1024 - 512;
/** Staged commands and upload parts. Under the files root so the files API can write them. */
const STAGING_DIR = `${FILES_ROOT}/.rivet-exec`;
const READY_POLL_MS = 1000;
/** After a kill, the stream should end at once. Past this, the wait is abandoned. */
const KILL_GRACE_MS = 10_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GONE_STATES = new Set([
	"deleted",
	"stopped",
	"error",
	"host_removed",
	"host_lost",
]);

/**
 * Runs an agent's file and shell tools in a kosa8 Cloud sandbox, a microVM
 * with its own kernel. The sandbox sleeps with its memory saved while the
 * Actor sleeps, and wakes in place on the next command.
 */
export function kosa8Provider(
	options: Kosa8ProviderOptions = {},
): SandboxProvider {
	const cwd = posix.normalize(options.cwd ?? FILES_ROOT);
	if (!posix.isAbsolute(cwd))
		throw new Error(`kosa8 cwd must be an absolute path, received ${cwd}`);
	let api: Kosa8Api | undefined;
	const kosa8 = () => {
		api ??= new Kosa8Api(options);
		return api;
	};
	const readyTimeoutMs = options.readyTimeoutMs ?? 5 * 60_000;
	return {
		name: "kosa8",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: (options.create ?? {});
			const { sandbox } = await kosa8().json<{ sandbox: { id: string } }>(
				"POST",
				"/v1/sandboxes",
				{ body: create },
			);
			return sandbox.id;
		},
		connect: async (_c, id) => {
			const api = kosa8();
			const deadline = Date.now() + readyTimeoutMs;
			while (true) {
				let state: string | undefined;
				try {
					state = (
						await api.json<{ sandbox: { state?: string } }>(
							"GET",
							`/v1/sandboxes/${encodeURIComponent(id)}`,
						)
					).sandbox.state;
				} catch (error) {
					if (sandboxGone(error)) return undefined;
					throw error;
				}
				if (state && GONE_STATES.has(state)) return undefined;
				// A sleeping sandbox wakes on its next command.
				if (state !== "creating") break;
				if (Date.now() >= deadline)
					throw new Error(
						`kosa8 sandbox ${id} was still booting after ${readyTimeoutMs} ms`,
					);
				await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
			}
			const sandbox = kosa8Sandbox(api, id, cwd);
			await sandbox.mkdir(cwd);
			return sandbox;
		},
		suspend: async (_c, id) => {
			// 409: it is already asleep, or it cannot sleep (a persistent sandbox stays up).
			await ignoreRefusal(
				kosa8().json("POST", `/v1/sandboxes/${encodeURIComponent(id)}/sleep`),
				[404, 409],
			);
		},
		destroy: async (_c, id) => {
			await ignoreRefusal(
				kosa8().json("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`),
				[404],
			);
		},
	};
}

/** A 404 for the sandbox itself. A missing file also answers 404, with a different message. */
function sandboxGone(error: unknown): boolean {
	return (
		error instanceof Kosa8ApiError &&
		error.status === 404 &&
		/no such sandbox/i.test(error.message)
	);
}

async function ignoreRefusal(
	operation: Promise<unknown>,
	statuses: number[],
): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (!(error instanceof Kosa8ApiError && statuses.includes(error.status)))
			throw error;
	}
}

function underFilesRoot(path: string): boolean {
	return path === FILES_ROOT || path.startsWith(`${FILES_ROOT}/`);
}

// Records the shell's pid so a kill can find the command's process tree,
// since closing the exec stream does not stop the command. A kill that
// arrives before the pid is written leaves a marker the wrapper checks. The
// command is the fourth argument, or a staged script file when it is longer
// than one exec argument may be.
const EXEC_WRAPPER =
	'd=/tmp/.rivet-exec; mkdir -p $d && echo $$ > "$d/$1"; if [ -f "$d/$1.kill" ]; then rm -f "$d/$1" "$d/$1.kill"; exit 137; fi; cd -- "$2" || { rm -f "$d/$1"; exit 1; }; if [ "$3" = file ]; then /bin/sh "$4"; s=$?; rm -f -- "$4"; else /bin/sh -c "$4"; s=$?; fi; rm -f "$d/$1"; exit $s';

// Stops each process before reading its children so none can fork past the kill.
const KILL_TREE =
	't() { kill -STOP "$1" 2>/dev/null; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do t "$c"; done; kill -KILL "$1" 2>/dev/null; }; d=/tmp/.rivet-exec; mkdir -p $d && touch "$d/$1.kill"; if [ -f "$d/$1" ]; then t "$(cat "$d/$1")"; rm -f "$d/$1" "$d/$1.kill"; fi';

// Writes the staged parts ("$@") to the target ("$1") in order, then removes them.
const ASSEMBLE =
	't=$1; shift; cat -- "$@" > "$t"; s=$?; rm -f -- "$@"; exit $s';

function kosa8Sandbox(api: Kosa8Api, id: string, cwd: string): Sandbox {
	const base = `/v1/sandboxes/${encodeURIComponent(id)}`;
	const run = (argv: string[], onData?: (chunk: Uint8Array) => void) =>
		api.exec(id, argv, { onData });
	const check = async (operation: string, path: string, script: string) => {
		const result = await run(["/bin/sh", "-c", script, "sh", path]);
		if (result.exitCode !== 0)
			throw new Error(
				`kosa8 ${operation} ${path} failed: ${Buffer.concat(result.stderr).toString().trim() || `exit code ${result.exitCode}`}`,
			);
		return Buffer.concat(result.stdout);
	};
	const upload = async (path: string, data: Uint8Array) => {
		await api.json("POST", `${base}/files/mkdir`, {
			body: { path: posix.dirname(path) },
		});
		await api.json("PUT", `${base}/files`, {
			query: { path },
			bytes: data,
		});
	};
	/** Uploads `data` in parts under the files root and returns their paths. */
	const stage = async (data: Uint8Array) => {
		const batch = randomUUID();
		const parts: string[] = [];
		for (
			let offset = 0;
			offset < data.length || parts.length === 0;
			offset += FILE_PART_BYTES
		) {
			const part = `${STAGING_DIR}/${batch}.${parts.length}`;
			parts.push(part);
			await upload(part, data.subarray(offset, offset + FILE_PART_BYTES));
		}
		return parts;
	};
	return {
		cwd,
		exec: (command, options) => exec(api, id, command, options, stage),
		readFile: async (path) => {
			if (underFilesRoot(path)) {
				try {
					return await api.bytes("GET", `${base}/files`, { query: { path } });
				} catch (error) {
					// 413: above the files API's request limit, so read it over exec.
					if (!(error instanceof Kosa8ApiError && error.status === 413))
						throw error;
				}
			}
			return new Uint8Array(await check("readFile", path, 'cat -- "$1"'));
		},
		writeFile: async (path, content) => {
			const data = new TextEncoder().encode(content);
			if (underFilesRoot(path) && data.length <= FILE_PART_BYTES) {
				await api.json("PUT", `${base}/files`, {
					query: { path },
					bytes: data,
				});
				return;
			}
			const parts = await stage(data);
			const result = await run([
				"/bin/sh",
				"-c",
				ASSEMBLE,
				"sh",
				path,
				...parts,
			]);
			if (result.exitCode !== 0)
				throw new Error(
					`kosa8 writeFile ${path} failed: ${Buffer.concat(result.stderr).toString().trim() || `exit code ${result.exitCode}`}`,
				);
		},
		mkdir: async (path) => {
			if (underFilesRoot(path)) {
				await api.json("POST", `${base}/files/mkdir`, { body: { path } });
				return;
			}
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
				)
					.toString()
					.trim() === "d",
		}),
		readdir: async (path) =>
			(
				await check(
					"readdir",
					path,
					'cd -- "$1" || exit 1; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done',
				)
			)
				.toString()
				.split("\0")
				.filter(Boolean),
		exists: async (path) =>
			(await run(["/bin/sh", "-c", '[ -e "$1" ]', "sh", path])).exitCode === 0,
	};
}

async function exec(
	api: Kosa8Api,
	id: string,
	command: string,
	options: SandboxExecOptions,
	stage: (data: Uint8Array) => Promise<string[]>,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	for (const key of Object.keys(options.env ?? {}))
		if (!ENV_NAME.test(key))
			throw new Error(`invalid kosa8 env variable name ${key}`);
	const token = randomUUID();
	const bytes = new TextEncoder().encode(command);
	const argv =
		bytes.length <= MAX_INLINE_COMMAND_BYTES
			? [
					"/bin/sh",
					"-c",
					EXEC_WRAPPER,
					"sh",
					token,
					options.cwd,
					"inline",
					command,
				]
			: [
					"/bin/sh",
					"-c",
					EXEC_WRAPPER,
					"sh",
					token,
					options.cwd,
					"file",
					// A staged script is one part: commands never approach 8 MiB.
					...(await stage(bytes)).slice(0, 1),
				];
	const stream = new AbortController();
	let ended: "aborted" | "timeout" | undefined;
	let grace: NodeJS.Timeout | undefined;
	const kill = (reason: "aborted" | "timeout") => {
		if (ended) return;
		ended = reason;
		api.exec(id, ["/bin/sh", "-c", KILL_TREE, "sh", token]).catch(() => {});
		grace = setTimeout(() => stream.abort(), KILL_GRACE_MS);
	};
	const abort = () => kill("aborted");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = options.timeoutMs
		? setTimeout(() => kill("timeout"), options.timeoutMs)
		: undefined;
	const output: ExecOutput = { exitCode: null, stdout: [], stderr: [] };
	try {
		let result: ExecOutput;
		try {
			result = await api.exec(id, argv, {
				env: options.env,
				onData: options.onData,
				signal: stream.signal,
				output,
			});
		} catch (error) {
			if (ended === "aborted") throw new Error("aborted");
			// The stream was cut after the kill grace: keep what it printed.
			if (ended === "timeout") result = output;
			else throw error;
		}
		if (ended === "aborted") throw new Error("aborted");
		return {
			exitCode: ended === "timeout" ? null : result.exitCode,
			timedOut: ended === "timeout",
			stdout: Buffer.concat(result.stdout).toString(),
			stderr: Buffer.concat(result.stderr).toString(),
		};
	} finally {
		clearTimeout(timer);
		clearTimeout(grace);
		options.signal?.removeEventListener("abort", abort);
	}
}

interface ExecOutput {
	exitCode: number | null;
	stdout: Buffer[];
	stderr: Buffer[];
}

interface RequestOptions {
	query?: Record<string, string>;
	body?: unknown;
	bytes?: Uint8Array;
	signal?: AbortSignal;
}

/** The few kosa8 Cloud REST calls the provider makes, over `fetch`. */
class Kosa8Api {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetch: typeof fetch;

	constructor(options: Kosa8ProviderOptions) {
		const apiKey = options.apiKey ?? process.env.KOSA8_API_KEY;
		if (!apiKey)
			throw new Error(
				"kosa8Provider needs an API key: pass apiKey or set KOSA8_API_KEY (create one at https://app.kosa8.com)",
			);
		this.apiKey = apiKey;
		this.baseUrl = (
			options.baseUrl ??
			process.env.KOSA8_API_URL ??
			DEFAULT_BASE_URL
		).replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
	}

	async json<T = unknown>(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const response = await this.request(method, path, options);
		const text = await response.text();
		return (text ? JSON.parse(text) : {}) as T;
	}

	async bytes(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<Uint8Array> {
		const response = await this.request(method, path, options);
		return new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * Runs `argv` over the streamed exec, whose NDJSON frames carry base64
	 * stdout and stderr, then `{done, exit}` or `{done, error}`.
	 */
	async exec(
		id: string,
		argv: string[],
		options: {
			env?: Record<string, string>;
			onData?: (chunk: Uint8Array) => void;
			signal?: AbortSignal;
			/** Collects the output as it arrives, so a caller keeps it when the stream is cut. */
			output?: ExecOutput;
		} = {},
	): Promise<ExecOutput> {
		const body: Record<string, unknown> = { cmd: argv, stream: true };
		if (options.env && Object.keys(options.env).length)
			body.env = Object.entries(options.env).map(
				([key, value]) => `${key}=${value}`,
			);
		const response = await this.request(
			"POST",
			`/v1/sandboxes/${encodeURIComponent(id)}/exec`,
			{ body, signal: options.signal },
		);
		if (!response.body) throw new Error("kosa8 exec answered without a body");
		const output = options.output ?? { exitCode: null, stdout: [], stderr: [] };
		const decoder = new TextDecoder();
		let pending = "";
		const onLine = (line: string): ExecOutput | undefined => {
			if (!line.trim()) return undefined;
			const frame = JSON.parse(line) as {
				stream?: string;
				data?: string;
				done?: boolean;
				exit?: number | null;
				error?: string;
				code?: string;
			};
			if (frame.done) {
				if (frame.error)
					throw new Kosa8ApiError(
						`kosa8 command did not finish: ${frame.error}`,
						200,
						frame.code,
					);
				output.exitCode = Number.isInteger(frame.exit)
					? (frame.exit as number)
					: null;
				return output;
			}
			if (
				(frame.stream === "stdout" || frame.stream === "stderr") &&
				frame.data
			) {
				const chunk = Buffer.from(frame.data, "base64");
				(frame.stream === "stdout" ? output.stdout : output.stderr).push(chunk);
				options.onData?.(chunk);
			}
			return undefined;
		};
		for await (const bytes of response.body) {
			pending += decoder.decode(bytes, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				const done = onLine(pending.slice(0, newline));
				if (done) return done;
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
		const done = onLine(pending + decoder.decode());
		if (done) return done;
		throw new Error("kosa8 exec stream ended without a final frame");
	}

	private async request(
		method: string,
		path: string,
		options: RequestOptions,
	): Promise<Response> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {}))
			url.searchParams.set(key, value);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
		};
		let body: RequestInit["body"];
		if (options.bytes) {
			headers["Content-Type"] = "application/octet-stream";
			body = options.bytes;
		} else if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify(options.body);
		}
		const response = await this.fetch(url, {
			method,
			headers,
			body,
			signal: options.signal,
		});
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		let code: string | undefined;
		let message = response.statusText || "request failed";
		try {
			const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
			if (typeof parsed.error === "string") code = parsed.error;
			if (typeof parsed.message === "string") message = parsed.message;
		} catch {}
		throw new Kosa8ApiError(
			`kosa8 ${method} ${url.pathname} failed: ${message} (HTTP ${response.status}${code ? `, ${code}` : ""})`,
			response.status,
			code,
		);
	}
}
