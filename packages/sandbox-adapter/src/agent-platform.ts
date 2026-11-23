import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** The shell server inside a shell sandbox listens on this port. */
const SHELL_PORT = "8080";
/** File content written per command. Its base64 must fit in one 128 KiB shell argument. */
const WRITE_CHUNK_BYTES = 48 * 1024;
const TEMPLATE_NAME =
	/^(projects\/[^/]+\/locations\/([^/]+)\/reasoningEngines\/[^/]+)\/sandboxEnvironmentTemplates\/[^/]+$/;

/** Supplies OAuth access tokens. A `GoogleAuth` from `google-auth-library` fits. */
export interface AgentPlatformAuth {
	getAccessToken(): Promise<string | null | undefined>;
}

/** Fields of the `SandboxEnvironment` sent when a sandbox is created. */
export interface AgentPlatformCreateOptions {
	/** Defaults to `rivet-<actor id>`. */
	displayName?: string;
	/** How long the sandbox lives before it is deleted, such as `"86400s"`. */
	ttl?: string;
	/** Snapshot to restore, `.../sandboxEnvironmentSnapshots/{id}`. */
	sandboxEnvironmentSnapshot?: string;
	owner?: string;
}

export interface AgentPlatformProviderOptions {
	/**
	 * Shell sandbox template, in the form
	 * `projects/{project}/locations/{location}/reasoningEngines/{engine}/sandboxEnvironmentTemplates/{template}`.
	 * Sandboxes are created in the template's Agent Engine.
	 */
	template: string;
	/** Fields of the created sandbox, or a function that returns them for the owning Actor. */
	create?:
		| AgentPlatformCreateOptions
		| ((
				c: SandboxActorContext,
		  ) => AgentPlatformCreateOptions | Promise<AgentPlatformCreateOptions>);
	/**
	 * Defaults to a `GoogleAuth` from `google-auth-library` with the
	 * `cloud-platform` scope, which uses Application Default Credentials.
	 */
	auth?: AgentPlatformAuth;
	/** Defaults to `https://{location}-aiplatform.googleapis.com`, using the template's location. */
	apiEndpoint?: string;
	/** Working directory inside the sandbox, created when the Actor connects. Defaults to `/workspace`. */
	cwd?: string;
	/** How long `create` and `connect` wait for the sandbox to run. Defaults to 5 minutes. */
	readyTimeoutMs?: number;
}

/**
 * Runs an agent's file and shell tools in a Google Cloud Agent Platform shell
 * sandbox. The sandbox is paused while the actor sleeps and deleted when the
 * actor is destroyed.
 */
export function agentPlatformProvider(
	options: AgentPlatformProviderOptions,
): SandboxProvider {
	const match = TEMPLATE_NAME.exec(options.template);
	if (!match)
		throw new Error(
			`agent-platform template must be a sandboxEnvironmentTemplates resource name, received ${options.template}`,
		);
	const [, engine, location] = match;
	const cwd = posix.normalize(options.cwd ?? "/workspace");
	if (!posix.isAbsolute(cwd))
		throw new Error(
			`agent-platform cwd must be an absolute path, received ${cwd}`,
		);
	const readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
	const api = new AgentPlatformApi(
		(
			options.apiEndpoint ?? `https://${location}-aiplatform.googleapis.com`
		).replace(/\/+$/, ""),
		options.auth,
	);
	return {
		name: "agent-platform",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: options.create;
			const operation = await api.request<Operation>(
				"POST",
				`${engine}/sandboxEnvironments`,
				{
					displayName: `rivet-${c.actorId}`,
					sandboxEnvironmentTemplate: options.template,
					...create,
				},
			);
			const sandbox = await api.wait<SandboxEnvironment>(
				operation,
				readyTimeoutMs,
				"create",
			);
			// A sandbox's operations are named after it.
			const name =
				sandbox?.name ?? operation.name?.split("/operations/")[0] ?? "";
			if (!name.includes("/sandboxEnvironments/"))
				throw new Error("agent-platform create returned no sandbox name");
			return name;
		},
		connect: async (_c, id) => {
			if (!(await waitUntilRunning(api, id, readyTimeoutMs))) return undefined;
			const sandbox = agentPlatformSandbox(api, id, cwd);
			await sandbox.mkdir(cwd);
			return sandbox;
		},
		suspend: async (_c, id) => {
			try {
				await api.request("POST", `${id}:pause`, {});
			} catch (error) {
				// A failed precondition means the sandbox is not running.
				if (!isStatus(error, "NOT_FOUND", "FAILED_PRECONDITION")) throw error;
			}
		},
		destroy: async (_c, id) => {
			try {
				await api.request("DELETE", id);
			} catch (error) {
				if (!isStatus(error, "NOT_FOUND")) throw error;
			}
		},
	};
}

interface Operation {
	name?: string;
	done?: boolean;
	error?: { code?: number; message?: string };
	response?: unknown;
}

interface SandboxEnvironment {
	name?: string;
	state?: string;
}

/** The result `/exec` returns for one command. */
interface ShellResult {
	stdout: string;
	stderr: string;
	returncode: number;
	duration_ms: number;
}

/** An error response from the Agent Platform API. */
export class AgentPlatformApiError extends Error {
	constructor(
		readonly httpStatus: number,
		readonly status: string | undefined,
		message: string,
	) {
		super(message);
	}
}

function isStatus(error: unknown, ...statuses: string[]): boolean {
	return (
		error instanceof AgentPlatformApiError &&
		error.status !== undefined &&
		statuses.includes(error.status)
	);
}

class AgentPlatformApi {
	private auth: Promise<AgentPlatformAuth> | undefined;

	constructor(
		private readonly endpoint: string,
		auth: AgentPlatformAuth | undefined,
	) {
		if (auth) this.auth = Promise.resolve(auth);
	}

	async request<T>(
		method: string,
		name: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		this.auth ??= defaultAuth();
		const token = await (await this.auth).getAccessToken();
		if (!token) throw new Error("agent-platform could not get an access token");
		const response = await fetch(`${this.endpoint}/v1/${name}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		if (response.ok) return (text ? JSON.parse(text) : {}) as T;
		let status: string | undefined;
		let message = text;
		try {
			const error = (
				JSON.parse(text) as { error?: { status?: string; message?: string } }
			).error;
			status = error?.status;
			message = error?.message ?? text;
		} catch {}
		throw new AgentPlatformApiError(
			response.status,
			status,
			`agent-platform ${method} ${name} failed with ${response.status}: ${message}`,
		);
	}

	/** Polls a long-running operation until it is done and returns its response. */
	async wait<T>(
		operation: Operation,
		timeoutMs: number,
		label: string,
	): Promise<T | undefined> {
		const deadline = Date.now() + timeoutMs;
		while (!operation.done) {
			if (!operation.name)
				throw new Error(`agent-platform ${label} returned no operation name`);
			if (Date.now() >= deadline)
				throw new Error(
					`agent-platform ${label} did not finish within ${timeoutMs} ms`,
				);
			await delay(1_000);
			operation = await this.request<Operation>("GET", operation.name);
		}
		if (operation.error)
			throw new Error(
				`agent-platform ${label} failed: ${operation.error.message ?? `code ${operation.error.code}`}`,
			);
		return operation.response as T | undefined;
	}
}

async function defaultAuth(): Promise<AgentPlatformAuth> {
	const { GoogleAuth } = await import("google-auth-library");
	return new GoogleAuth({ scopes: [SCOPE] });
}

/**
 * Resumes a paused sandbox and waits until it runs. Returns false when it no
 * longer exists.
 */
async function waitUntilRunning(
	api: AgentPlatformApi,
	id: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let resumed = false;
	while (true) {
		let sandbox: SandboxEnvironment;
		try {
			sandbox = await api.request<SandboxEnvironment>("GET", id);
		} catch (error) {
			if (isStatus(error, "NOT_FOUND")) return false;
			throw error;
		}
		switch (sandbox.state) {
			case "STATE_RUNNING":
				return true;
			case "STATE_STOPPING":
			case "STATE_DEPROVISIONING":
			case "STATE_TERMINATED":
			case "STATE_DELETED":
				return false;
			case "STATE_PAUSED":
				if (resumed) break;
				resumed = true;
				try {
					await api.request("POST", `${id}:resume`, {});
				} catch (error) {
					if (isStatus(error, "NOT_FOUND")) return false;
					// Another caller resumed it first.
					if (!isStatus(error, "FAILED_PRECONDITION")) throw error;
				}
				break;
		}
		// Provisioning, pausing, and resuming sandboxes settle on their own.
		if (Date.now() >= deadline)
			throw new Error(
				`agent-platform sandbox ${id} was still ${sandbox.state} after ${timeoutMs} ms`,
			);
		await delay(1_000);
	}
}

function agentPlatformSandbox(
	api: AgentPlatformApi,
	id: string,
	cwd: string,
): Sandbox {
	const shell = async (
		command: string,
		commandCwd: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<ShellResult> => {
		const request = {
			command,
			cwd: commandCwd,
			...(timeoutMs ? { timeout: Math.ceil(timeoutMs / 1000) } : {}),
		};
		// The API forwards the JSON chunk as a POST to the shell server's `/exec`.
		const response = await api.request<{ outputs?: { data?: string }[] }>(
			"POST",
			`${id}:execute`,
			{
				inputs: [
					chunk("application/x.sandbox-request-uri", "/exec"),
					chunk("application/x.sandbox-request-port", SHELL_PORT),
					chunk("application/json", JSON.stringify(request)),
				],
			},
			signal,
		);
		const output = response.outputs?.find((entry) => entry.data)?.data;
		if (!output)
			throw new Error(
				`agent-platform sandbox ${id} returned no command output`,
			);
		return JSON.parse(Buffer.from(output, "base64").toString()) as ShellResult;
	};
	/** Runs a file operation and throws when it fails. */
	const check = async (operation: string, path: string, script: string) => {
		const result = await shell(script, "/");
		if (result.returncode !== 0)
			throw new Error(
				`agent-platform ${operation} ${path} failed: ${result.stderr.trim() || `exit code ${result.returncode}`}`,
			);
		return result.stdout;
	};
	return {
		cwd,
		exec: (command, options) => exec(shell, command, options),
		readFile: async (path) =>
			new Uint8Array(
				Buffer.from(
					await check("readFile", path, `base64 < ${shellQuote(path)}`),
					"base64",
				),
			),
		writeFile: async (path, content) => {
			const data = Buffer.from(content);
			const write = (target: string, offset: number) =>
				check(
					"writeFile",
					path,
					`printf '%s' '${data.subarray(offset, offset + WRITE_CHUNK_BYTES).toString("base64")}' | base64 -d ${offset === 0 ? ">" : ">>"} ${shellQuote(target)}`,
				);
			if (data.length <= WRITE_CHUNK_BYTES) {
				await write(path, 0);
				return;
			}
			// Larger content is assembled next to the file and moved into place.
			const temporary = `${path}.rivet-${randomUUID()}`;
			try {
				for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_BYTES)
					await write(temporary, offset);
				await check(
					"writeFile",
					path,
					`mv -f -- ${shellQuote(temporary)} ${shellQuote(path)}`,
				);
			} catch (error) {
				await shell(`rm -f -- ${shellQuote(temporary)}`, "/").catch(() => {});
				throw error;
			}
		},
		mkdir: async (path) => {
			await check("mkdir", path, `mkdir -p -- ${shellQuote(path)}`);
		},
		stat: async (path) => {
			const quoted = shellQuote(path);
			const kind = await check(
				"stat",
				path,
				`if [ -d ${quoted} ]; then echo d; elif [ -e ${quoted} ]; then echo f; else echo "no such file or directory" >&2; exit 1; fi`,
			);
			return { isDirectory: kind.trim() === "d" };
		},
		readdir: async (path) =>
			(
				await check(
					"readdir",
					path,
					`cd -- ${shellQuote(path)} || exit 1; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\\0' "$f"; fi; done`,
				)
			)
				.split("\0")
				.filter(Boolean),
		exists: async (path) =>
			(await shell(`[ -e ${shellQuote(path)} ]`, "/")).returncode === 0,
	};
}

/**
 * The shell server returns a command's output once it ends and has no way to
 * stop one. Aborting ends only the wait: the command keeps running in the
 * sandbox until it exits or reaches its timeout.
 */
async function exec(
	shell: (
		command: string,
		cwd: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	) => Promise<ShellResult>,
	command: string,
	options: SandboxExecOptions,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	let result: ShellResult;
	try {
		result = await shell(
			withEnv(command, options.env),
			options.cwd,
			options.timeoutMs,
			options.signal,
		);
	} catch (error) {
		if (options.signal?.aborted) throw new Error("aborted");
		// The server kills a command at its timeout and fails the request
		// without the command's output.
		if (isTimeout(error))
			return { exitCode: null, timedOut: true, stdout: "", stderr: "" };
		throw error;
	}
	if (result.stdout) options.onData?.(Buffer.from(result.stdout));
	if (result.stderr) options.onData?.(Buffer.from(result.stderr));
	return {
		// A negative code means a signal ended the command.
		exitCode: result.returncode < 0 ? null : result.returncode,
		timedOut: false,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function isTimeout(error: unknown): boolean {
	return (
		isStatus(error, "FAILED_PRECONDITION") &&
		(error as Error).message.includes("DEADLINE_EXCEEDED")
	);
}

/** The shell server has no environment field, so variables are exported first. */
function withEnv(command: string, env: Record<string, string> = {}): string {
	const entries = Object.entries(env);
	if (entries.length === 0) return command;
	for (const [key] of entries)
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			throw new Error(`invalid agent-platform env variable name ${key}`);
	return `export ${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")}\n${command}`;
}

function chunk(mimeType: string, data: string) {
	return { mimeType, data: Buffer.from(data).toString("base64") };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
