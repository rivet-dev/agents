import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	toError,
} from "@earendil-works/pi-durable/env";
import type { Sandbox } from "@rivet-dev/sandbox-adapter";
import { resolveSandboxPath, shellQuote } from "../sandbox.js";

/**
 * Pi Durable's `ExecutionEnv` inside a sandbox, for Pi's built-in tools
 * (`CodingTools`). Paths outside the sandbox `cwd` are rejected, and commands
 * never receive the actor host's environment variables.
 *
 * Only the operations Pi's tools use are supported. Every other operation
 * returns a `not_supported` error. Failures are returned, never thrown.
 */
export function sandboxEnv(
	id: string,
	sandbox: Sandbox,
	cwd: string | undefined,
): ExecutionEnv {
	const root = sandbox.cwd;
	const inside = (path: string): Result<string, FileError> => {
		try {
			return ok(resolveSandboxPath(root, path));
		} catch (error) {
			const cause = toError(error);
			return err(
				new FileError("permission_denied", cause.message, path, cause),
			);
		}
	};
	const initialCwd = inside(cwd ?? root);
	if (!initialCwd.ok) throw initialCwd.error;

	const env: ExecutionEnv = {
		id,
		cwd: initialCwd.value,

		absolutePath: async (path) => inside(posix.resolve(env.cwd, path)),
		joinPath: async (parts) => ok(posix.join(...parts)),
		exists: (path) =>
			onPath(inside(path), (resolved) => sandbox.exists(resolved)),
		readTextFile: async (path) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return read(sandbox, resolved.value, async () =>
				new TextDecoder().decode(await sandbox.readFile(resolved.value)),
			);
		},
		readBinaryFile: async (path) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return read(sandbox, resolved.value, () =>
				sandbox.readFile(resolved.value),
			);
		},
		writeFile: async (path, content) => {
			if (typeof content !== "string") {
				return notSupported("writing binary content", path);
			}
			return onPath(inside(path), async (resolved) => {
				await sandbox.mkdir(posix.dirname(resolved));
				await sandbox.writeFile(resolved, content);
			});
		},
		fileInfo: async (path) => {
			const resolved = inside(path);
			return resolved.ok ? fileInfo(sandbox, resolved.value) : resolved;
		},
		// Pi's tools fall back to the absolute path when canonical paths are not supported.
		canonicalPath: async (path) => notSupported("canonicalPath", path),

		exec: async (command, options, context) => {
			const cwd = inside(options?.cwd ?? env.cwd);
			if (!cwd.ok) {
				return err(
					new ExecutionError("spawn_error", cwd.error.message, cwd.error),
				);
			}
			return exec(sandbox, command, options, context, cwd.value);
		},

		openTextLineReader: async (path) =>
			notSupported("openTextLineReader", path),
		readTextLines: async (path) => notSupported("readTextLines", path),
		appendFile: async (path) => notSupported("appendFile", path),
		truncateFile: async (path) => notSupported("truncateFile", path),
		flushFile: async (path) => notSupported("flushFile", path),
		renameFile: async (path) => notSupported("renameFile", path),
		listDir: async (path) => notSupported("listDir", path),
		createDir: async (path) => notSupported("createDir", path),
		remove: async (path) => notSupported("remove", path),
		createTempDir: async () => notSupported("createTempDir"),
		createTempFile: async () => notSupported("createTempFile"),
		cleanup: async () => {},
	};
	return env;
}

function notSupported<T>(
	operation: string,
	path?: string,
): Result<T, FileError> {
	return err(
		new FileError(
			"not_supported",
			`${operation} is not supported in a sandbox`,
			path,
		),
	);
}

/** Runs a sandbox operation on a checked path and returns its failure as a `FileError`. */
async function onPath<T>(
	path: Result<string, FileError>,
	operation: (resolved: string) => Promise<T>,
): Promise<Result<T, FileError>> {
	if (!path.ok) return path;
	try {
		return ok(await operation(path.value));
	} catch (error) {
		const cause = toError(error);
		return err(new FileError("unknown", cause.message, path.value, cause));
	}
}

/** A read of a missing file reports `not_found`, which Pi's tools rely on. */
async function read<T>(
	sandbox: Sandbox,
	path: string,
	operation: () => Promise<T>,
): Promise<Result<T, FileError>> {
	try {
		return ok(await operation());
	} catch (error) {
		const cause = toError(error);
		const code = (await sandbox.exists(path).catch(() => true))
			? "unknown"
			: "not_found";
		return err(new FileError(code, cause.message, path, cause));
	}
}

const STAT_KINDS: Record<string, FileKind> = {
	"regular file": "file",
	"regular empty file": "file",
	directory: "directory",
	"symbolic link": "symlink",
};

async function fileInfo(
	sandbox: Sandbox,
	path: string,
): Promise<Result<FileInfo, FileError>> {
	let result: Awaited<ReturnType<Sandbox["exec"]>>;
	try {
		result = await sandbox.exec(`stat -c '%F|%s|%Y' -- ${shellQuote(path)}`, {
			cwd: sandbox.cwd,
		});
	} catch (error) {
		const cause = toError(error);
		return err(new FileError("unknown", cause.message, path, cause));
	}
	if (result.exitCode !== 0) {
		const code = /No such file/i.test(result.stderr) ? "not_found" : "unknown";
		return err(
			new FileError(
				code,
				result.stderr.trim() || `stat exited with ${result.exitCode}`,
				path,
			),
		);
	}
	const [type = "", size = "", modified = ""] = result.stdout.trim().split("|");
	const kind = STAT_KINDS[type];
	if (!kind) {
		return err(
			new FileError(
				"invalid",
				`${path} is a ${type}, not a file, directory, or symlink`,
				path,
			),
		);
	}
	return ok({
		name: posix.basename(path),
		path,
		kind,
		size: Number(size),
		mtimeMs: Number(modified) * 1000,
	});
}

/**
 * Runs a command in the sandbox. `timeout` is in seconds, as in Pi. Commands
 * get only the variables in `options.env`. `inheritEnv` would mean the actor
 * host's environment, which holds provider keys, so it is ignored.
 */
async function exec(
	sandbox: Sandbox,
	command: string,
	options: ShellExecOptions | undefined,
	context: Context,
	cwd: string,
): Promise<Result<ShellExecResult, ExecutionError>> {
	const decoder = new TextDecoder();
	const output = (text: string) => {
		if (text) options?.onOutput?.(text, context);
	};
	try {
		const result = await sandbox.exec(command, {
			cwd,
			env: options?.env,
			timeoutMs:
				options?.timeout === undefined ? undefined : options.timeout * 1000,
			signal: context.abortSignal,
			onData: (chunk) => output(decoder.decode(chunk, { stream: true })),
		});
		output(decoder.decode());
		if (result.timedOut) {
			return err(
				new ExecutionError(
					"timeout",
					`Command timed out after ${options?.timeout} seconds`,
				),
			);
		}
		if (result.exitCode === null) {
			return err(
				new ExecutionError("unknown", "Command was killed by a signal"),
			);
		}
		return ok({ exitCode: result.exitCode });
	} catch (error) {
		const cause = toError(error);
		const code = context.abortSignal?.aborted ? "aborted" : "spawn_error";
		return err(new ExecutionError(code, cause.message, cause));
	}
}
