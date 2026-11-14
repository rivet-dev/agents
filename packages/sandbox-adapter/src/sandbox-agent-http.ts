import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox } from "./index.js";
import { type RemoteProcessPoll, runRemoteProcess } from "./remote-process.js";

/** Returns the headers every request to the server needs, such as a proxy's auth token. */
export type SandboxAgentHeaders = () => Promise<Record<string, string>>;

interface ProcessInfo {
	id: string;
	pid?: number | null;
	status: "running" | "exited";
	exitCode?: number | null;
}

interface ProcessLogs {
	entries: Array<{
		sequence: number;
		stream: "stdout" | "stderr" | "combined" | "pty";
		data: string;
		encoding: string;
	}>;
}

/** An error response from a Sandbox Agent server. */
export class SandboxAgentHttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
		operation: string,
	) {
		super(`sandbox-agent ${operation} failed with ${status}: ${detail}`);
	}
}

/**
 * Kills a process and its descendants. Each process is stopped before its
 * children are listed so none can fork past the kill. Children are found by
 * the parent pid in `/proc/<pid>/stat`, because some kernels have no
 * `/proc/<pid>/task/<tid>/children`.
 */
const KILL_TREE = `c() {
	for s in /proc/[0-9]*/stat; do
		read -r l < "$s" 2>/dev/null || continue
		r=\${l##*")"}; r=\${r# }; p=\${r#* }; p=\${p%% *}
		if [ "$p" = "$1" ]; then d=\${s#/proc/}; echo "\${d%/stat}"; fi
	done
}
t() {
	kill -STOP "$1" 2>/dev/null
	for x in $(c "$1"); do t "$x"; done
	kill -KILL "$1" 2>/dev/null
}
t "$1"`;

/**
 * A client for the process and filesystem API of a Sandbox Agent server
 * running inside a sandbox.
 *
 * @internal
 */
export class SandboxAgentHttp {
	constructor(
		private readonly baseUrl: string,
		private readonly headers: SandboxAgentHeaders,
	) {}

	/**
	 * Waits until the server answers its health check. Returns false once
	 * `exists`, checked every few seconds, reports that the sandbox is gone.
	 */
	async waitUntilReady(
		timeoutMs: number,
		label: string,
		exists?: () => Promise<boolean>,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		let nextExistsCheck = Date.now() + 5_000;
		while (Date.now() < deadline) {
			if (exists && Date.now() >= nextExistsCheck) {
				if (!(await exists())) return false;
				nextExistsCheck = Date.now() + 5_000;
			}
			try {
				const response = await fetch(`${this.baseUrl}/v1/health`, {
					headers: await this.headers(),
					signal: AbortSignal.timeout(10_000),
				});
				await response.body?.cancel();
				if (response.ok) return true;
				lastError = new Error(`health check returned ${response.status}`);
			} catch (error) {
				lastError = error;
			}
			await delay(500);
		}
		throw new Error(
			`${label} did not answer within ${timeoutMs} ms. The image must run \`sandbox-agent server\`.`,
			{ cause: lastError },
		);
	}

	/** Returns a `Sandbox` whose commands and file operations go through this server. */
	sandbox(cwd: string): Sandbox {
		return {
			cwd,
			exec: async (command, options) => {
				if (options.signal?.aborted) throw new Error("aborted");
				const process = await this.json<ProcessInfo>(
					"POST",
					"/v1/processes",
					{},
					{
						command: "/bin/sh",
						args: ["-c", command],
						cwd: options.cwd,
						env: options.env ?? {},
					},
				);
				try {
					return await runRemoteProcess(
						{
							poll: (after) => this.poll(process.id, after),
							kill: () => this.killTree(process),
						},
						options,
					);
				} finally {
					// Frees the output the server keeps for the process. A process that
					// survived its kill cannot be deleted yet, so this is best effort.
					this.request(
						"DELETE",
						`/v1/processes/${encodeURIComponent(process.id)}`,
					).catch(() => {});
				}
			},
			readFile: async (path) =>
				new Uint8Array(
					await (
						await this.request("GET", "/v1/fs/file", { path })
					).arrayBuffer(),
				),
			writeFile: async (path, content) => {
				await this.request("PUT", "/v1/fs/file", { path }, content);
			},
			mkdir: async (path) => {
				await this.request("POST", "/v1/fs/mkdir", { path });
			},
			stat: async (path) => ({
				isDirectory:
					(
						await this.json<{ entryType: string }>("GET", "/v1/fs/stat", {
							path,
						})
					).entryType === "directory",
			}),
			readdir: async (path) =>
				(
					await this.json<Array<{ name: string }>>("GET", "/v1/fs/entries", {
						path,
					})
				).map((entry) => entry.name),
			exists: async (path) => {
				try {
					await this.request("GET", "/v1/fs/stat", { path });
					return true;
				} catch (error) {
					// The server reports a missing path as an invalid request.
					if (
						error instanceof SandboxAgentHttpError &&
						error.status === 400 &&
						error.detail.includes("path not found")
					)
						return false;
					throw error;
				}
			},
		};
	}

	/**
	 * Reads the process state before its output. The server records all output
	 * before it reports the exit, so output read after an exit is complete.
	 */
	private async poll(
		id: string,
		after: number | undefined,
	): Promise<RemoteProcessPoll> {
		const path = `/v1/processes/${encodeURIComponent(id)}`;
		const process = await this.json<ProcessInfo>("GET", path);
		const logs = await this.json<ProcessLogs>("GET", `${path}/logs`, {
			stream: "combined",
			...(after === undefined ? {} : { since: String(after) }),
		});
		return {
			chunks: logs.entries.map((entry) => ({
				sequence: entry.sequence,
				stream: entry.stream === "stderr" ? "stderr" : "stdout",
				data:
					entry.encoding === "base64"
						? Buffer.from(entry.data, "base64")
						: Buffer.from(entry.data),
			})),
			exit:
				process.status === "exited"
					? { exitCode: process.exitCode ?? null, timedOut: false }
					: undefined,
		};
	}

	/**
	 * Killing the shell alone would leave the command's children running, so
	 * this kills the tree first and then the shell through the server.
	 */
	private async killTree(process: ProcessInfo): Promise<void> {
		if (process.pid) {
			await this.json(
				"POST",
				"/v1/processes/run",
				{},
				{
					command: "/bin/sh",
					args: ["-c", KILL_TREE, "sh", String(process.pid)],
					timeoutMs: 10_000,
				},
			).catch(() => {});
		}
		await this.request(
			"POST",
			`/v1/processes/${encodeURIComponent(process.id)}/kill`,
		);
	}

	private async json<T>(
		method: string,
		path: string,
		query: Record<string, string> = {},
		body?: unknown,
	): Promise<T> {
		const response = await this.request(
			method,
			path,
			query,
			body === undefined ? undefined : JSON.stringify(body),
			body === undefined ? undefined : "application/json",
		);
		return (await response.json()) as T;
	}

	private async request(
		method: string,
		path: string,
		query: Record<string, string> = {},
		body?: string,
		contentType = "application/octet-stream",
	): Promise<Response> {
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(query))
			url.searchParams.set(key, value);
		const response = await fetch(url, {
			method,
			headers: {
				...(await this.headers()),
				...(body === undefined ? {} : { "content-type": contentType }),
			},
			body,
		});
		if (response.ok) return response;
		const text = await response.text();
		let detail = text;
		try {
			const problem = JSON.parse(text) as { detail?: string; title?: string };
			detail = problem.detail ?? problem.title ?? text;
		} catch {}
		throw new SandboxAgentHttpError(
			response.status,
			detail,
			`${method} ${path}`,
		);
	}
}
