import { posix } from "node:path";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxProvider,
} from "@rivet-dev/sandbox-adapter";
import type { Tool } from "nanocodex";
import {
	createWorkspace,
	type Workspace,
	type WorkspaceEntry,
} from "nanocodex/workspace";
import type { RawAccess } from "rivetkit/db";
import { loadSandbox, saveSandbox } from "./storage.js";

/** The `exec_command` output budget nanocodex's own one-shot `exec_command` uses. */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const OUTPUT_TRUNCATION_NOTICE = "\n[output truncated by exec_command]";

export interface SandboxContext extends SandboxActorContext {
	readonly db: RawAccess;
	readonly log: {
		warn(fields: Record<string, unknown>): void;
	};
}

export interface ConnectedSandbox {
	id: string;
	sandbox: Sandbox;
}

/**
 * Connects to the actor's sandbox, creating one when none is stored or the
 * provider reports that the stored one no longer exists.
 */
export async function connectSandbox(
	c: SandboxContext,
	provider: SandboxProvider,
): Promise<ConnectedSandbox> {
	const existing = await loadSandbox(c.db);
	if (existing && existing.provider !== provider.name) {
		throw new Error(
			`nanocodex sandbox was created by provider ${existing.provider}, but the actor now uses ${provider.name}`,
		);
	}
	if (existing) {
		const sandbox = await provider.connect(c, existing.id);
		if (sandbox) return { id: existing.id, sandbox };
		c.log.warn({
			msg: "nanocodex sandbox no longer exists, creating a new one; files from the previous sandbox are lost",
			sandboxId: existing.id,
		});
	}
	const id = await provider.create(c);
	await saveSandbox(c.db, { provider: provider.name, id });
	const sandbox = await provider.connect(c, id);
	if (!sandbox) {
		throw new Error(
			`nanocodex sandbox ${provider.name}/${id} was not found right after it was created`,
		);
	}
	return { id, sandbox };
}

/**
 * Suspends the sandbox this generation connected when the actor sleeps. On
 * destroy it destroys the actor's sandbox, also one stored by an earlier
 * generation that this one never connected.
 */
export async function closeSandbox(
	c: SandboxContext,
	provider: SandboxProvider,
	connected: ConnectedSandbox | undefined,
	reason: "sleep" | "destroy",
): Promise<void> {
	if (reason === "sleep") {
		if (connected && provider.suspend) await provider.suspend(c, connected.id);
		return;
	}
	if (!provider.destroy) return;
	const stored = connected ? undefined : await loadSandbox(c.db);
	const id =
		connected?.id ??
		(stored?.provider === provider.name ? stored.id : undefined);
	if (id !== undefined) await provider.destroy(c, id);
}

/**
 * The sandbox as nanocodex's workspace, which gives the model its file tools.
 * nanocodex passes paths relative to the sandbox `cwd` and rejects paths that
 * leave it.
 */
export function sandboxWorkspace(sandbox: Sandbox): Workspace {
	const absolute = (path: string) =>
		path === "" ? sandbox.cwd : posix.join(sandbox.cwd, path);
	return createWorkspace({
		root: sandbox.cwd,
		backend: {
			list: (path, options) =>
				listFiles(sandbox, path, absolute(path), options),
			readFile: (path) => sandbox.readFile(absolute(path)),
			writeFile: async (path, contents) => {
				const text = decodeUtf8(contents, path);
				await sandbox.mkdir(posix.dirname(absolute(path)));
				await sandbox.writeFile(absolute(path), text);
			},
			remove: async (path, options) => {
				if (path === "") {
					throw new Error("cannot remove the workspace root");
				}
				await run(
					sandbox,
					`rm ${options.recursive ? "-r " : ""}-- ${shellQuote(absolute(path))}`,
				);
			},
			mkdir: (path) => sandbox.mkdir(absolute(path)),
		},
	});
}

/** A one-shot `exec_command` with the parameter names Codex models use. */
export function execCommandTool(sandbox: Sandbox): Tool {
	return {
		description:
			"Run a one-shot shell command in the sandbox and return its output and exit code. There is no PTY and no background session: the call returns when the command exits.",
		parameters: {
			type: "object",
			properties: {
				cmd: { type: "string", description: "Shell command to execute." },
				workdir: {
					type: "string",
					description:
						"Working directory for the command. Defaults to the workspace root.",
				},
				max_output_tokens: {
					type: "integer",
					minimum: 1,
					description: "Output token budget. Defaults to 10000 tokens.",
				},
			},
			required: ["cmd"],
			additionalProperties: false,
		},
		handler: async (input, context) => {
			const { cmd, workdir, maxOutputTokens } = parseExecCommandInput(input);
			const startedAt = Date.now();
			const result = await sandbox.exec(cmd, {
				cwd:
					workdir === undefined
						? sandbox.cwd
						: posix.resolve(sandbox.cwd, workdir),
				signal: context.signal,
			});
			const combined = `${result.stdout}${result.stderr}`;
			const maxCharacters = maxOutputTokens * 4;
			const truncated = combined.length > maxCharacters;
			return {
				output: truncated
					? `${combined.slice(0, Math.max(0, maxCharacters - OUTPUT_TRUNCATION_NOTICE.length))}${OUTPUT_TRUNCATION_NOTICE}`
					: combined,
				wall_time_seconds: (Date.now() - startedAt) / 1000,
				...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
				...(truncated
					? { original_token_count: Math.ceil(combined.length / 4) }
					: {}),
			};
		},
	};
}

interface ExecCommandInput {
	readonly cmd: string;
	readonly workdir: string | undefined;
	readonly maxOutputTokens: number;
}

/**
 * Parses the model's `exec_command` arguments.
 *
 * @throws A `TypeError` the model reads as the tool's error, which is how
 * nanocodex reports invalid tool input.
 */
function parseExecCommandInput(input: unknown): ExecCommandInput {
	if (typeof input !== "object" || input === null) {
		throw new TypeError("exec_command input must be an object");
	}
	const cmd = "cmd" in input ? input.cmd : undefined;
	if (typeof cmd !== "string" || cmd.trim() === "") {
		throw new TypeError("exec_command.cmd must be a non-empty string");
	}
	const workdir = "workdir" in input ? input.workdir : undefined;
	if (workdir !== undefined && typeof workdir !== "string") {
		throw new TypeError("exec_command.workdir must be a string");
	}
	const maxOutputTokens =
		"max_output_tokens" in input ? input.max_output_tokens : undefined;
	if (
		maxOutputTokens !== undefined &&
		(typeof maxOutputTokens !== "number" ||
			!Number.isInteger(maxOutputTokens) ||
			maxOutputTokens < 1)
	) {
		throw new TypeError(
			"exec_command.max_output_tokens must be a positive integer",
		);
	}
	return {
		cmd,
		workdir,
		maxOutputTokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
	};
}

/**
 * Lists through `find` in one command, so a remote sandbox needs one round
 * trip. Entry paths are relative to the workspace root.
 */
async function listFiles(
	sandbox: Sandbox,
	path: string,
	directory: string,
	options: { recursive: boolean; maxEntries: number },
): Promise<WorkspaceEntry[]> {
	const depth = options.recursive ? "" : "-maxdepth 1 ";
	const output = await run(
		sandbox,
		`cd -- ${shellQuote(directory)} && find . -mindepth 1 ${depth}\\( -type d -exec printf 'd %s\\n' {} + \\) -o \\( -type f -exec printf 'f %s\\n' {} + \\) | head -n ${options.maxEntries}`,
	);
	return output
		.split("\n")
		.filter((line) => line.length > 2)
		.map((line) => ({
			kind: line[0] === "d" ? "directory" : "file",
			path: posix.join(path, line.slice(4)),
		}));
}

async function run(sandbox: Sandbox, command: string): Promise<string> {
	const result = await sandbox.exec(command, { cwd: sandbox.cwd });
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.trim() || `command failed: ${command}`);
	}
	return result.stdout;
}

function decodeUtf8(contents: Uint8Array, path: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(contents);
	} catch {
		throw new Error(`${path}: sandbox writes support UTF-8 text only`);
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
