import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	LineScanner,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	toError,
} from "@earendil-works/pi-durable/env";
import type { Sandbox } from "../index.js";

/**
 * Pi Durable's `ExecutionEnv` inside a sandbox, for Pi's built-in tools
 * (`CodingTools`). Paths outside the sandbox `cwd` are rejected, and commands
 * never receive the actor host's environment variables.
 *
 * Only the operations Pi's tools use are supported. Every other operation
 * returns a `not_supported` error. Operations return failures instead of
 * throwing. Building the environment throws when `cwd` is outside `root`.
 * `connect` runs on the first operation that needs the sandbox, so a tool
 * that never touches files or the shell never connects it.
 */
export function sandboxEnv(
	id: string,
	root: string,
	connect: () => Promise<Sandbox>,
	cwd: string | undefined,
): ExecutionEnv {
	/**
	 * Connects on first use. A failed connect becomes this call's error result.
	 * An aborted run stops before and after the connect. The connect itself
	 * keeps going, because other calls may wait on it.
	 */
	const withSandbox = async <T, E extends Error>(
		context: Context,
		fail: (cause: Error) => E,
		use: (sandbox: Sandbox) => Promise<Result<T, E>>,
	): Promise<Result<T, E>> => {
		if (context.abortSignal?.aborted) return err(fail(new Error("aborted")));
		let sandbox: Sandbox;
		try {
			sandbox = await connect();
		} catch (error) {
			return err(fail(toError(error)));
		}
		if (context.abortSignal?.aborted) return err(fail(new Error("aborted")));
		return use(sandbox);
	};
	const fileFailure = (path: string, context: Context) => (cause: Error) =>
		new FileError(
			context.abortSignal?.aborted ? "aborted" : "unknown",
			cause.message,
			path,
			cause,
		);
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
		exists: async (path, context) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), (sandbox) =>
				onPath(resolved, (target) => sandbox.exists(target)),
			);
		},
		readTextFile: async (path, context) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), (sandbox) =>
				read(sandbox, resolved.value, async () =>
					new TextDecoder().decode(await sandbox.readFile(resolved.value)),
				),
			);
		},
		readBinaryFile: async (path, context) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), (sandbox) =>
				read(sandbox, resolved.value, () => sandbox.readFile(resolved.value)),
			);
		},
		// The sandbox reads whole files, so the reader holds the file it opened.
		openBinaryReader: async (path, _options, context) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), async (sandbox) => {
				const info = await fileInfo(sandbox, resolved.value);
				if (!info.ok) return info;
				if (info.value.kind === "directory") {
					return err(
						new FileError(
							"is_directory",
							`${path} is a directory`,
							resolved.value,
						),
					);
				}
				const bytes = await read(sandbox, resolved.value, () =>
					sandbox.readFile(resolved.value),
				);
				if (!bytes.ok) return bytes;
				return ok(
					bufferReader(
						{ ...info.value, size: bytes.value.length },
						bytes.value,
					),
				);
			});
		},
		writeFile: async (path, content, context) => {
			if (typeof content !== "string") {
				return notSupported("writing binary content", path);
			}
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), (sandbox) =>
				onPath(resolved, async (target) => {
					await sandbox.mkdir(posix.dirname(target));
					await sandbox.writeFile(target, content);
				}),
			);
		},
		fileInfo: async (path, context) => {
			const resolved = inside(path);
			if (!resolved.ok) return resolved;
			return withSandbox(context, fileFailure(resolved.value, context), (sandbox) =>
				fileInfo(sandbox, resolved.value),
			);
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
			return withSandbox(
				context,
				(cause) =>
					new ExecutionError(
						context.abortSignal?.aborted ? "aborted" : "spawn_error",
						cause.message,
						cause,
					),
				(sandbox) => exec(sandbox, command, options, context, cwd.value),
			);
		},

		openTextLineReader: async (path) =>
			notSupported("openTextLineReader", path),
		readTextLines: async (path) => notSupported("readTextLines", path),
		appendFile: async (path) => notSupported("appendFile", path),
		truncateFile: async (path) => notSupported("truncateFile", path),
		flushFile: async (path) => notSupported("flushFile", path),
		renameFile: async (path) => notSupported("renameFile", path),
		listDir: async (path) => notSupported("listDir", path),
		openDirReader: async (path) => notSupported("openDirReader", path),
		watch: async () => notSupported("watch"),
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

/** Positional reads and line scans of a file already read into memory. */
function bufferReader(info: FileInfo, bytes: Uint8Array): BinaryReader {
	return {
		info: async () => ok(info),
		read: async (offset, length) => ok(bytes.subarray(offset, offset + length)),
		scanLines: async ({ startLine, endLine }) => {
			let scanner: LineScanner;
			try {
				scanner = new LineScanner(startLine, endLine);
			} catch {
				return err(new FileError("invalid", "Invalid line range", info.path));
			}
			scanner.push(bytes);
			return ok(scanner.finish());
		},
		close: async () => {},
	};
}

/**
 * Runs a command in the sandbox. An argument list is quoted into one shell
 * command. `timeout` is in seconds, as in Pi. Commands get only the variables
 * in `options.env`. `inheritEnv` would mean the actor host's environment,
 * which holds provider keys, so it is ignored. The sandbox reports stdout and
 * stderr as one stream, so every chunk is reported as stdout.
 */
async function exec(
	sandbox: Sandbox,
	command: string | readonly string[],
	options: ShellExecOptions | undefined,
	context: Context,
	cwd: string,
): Promise<Result<ShellExecResult, ExecutionError>> {
	const decoder = new TextDecoder();
	const output = (text: string) => {
		if (text) options?.onOutput?.(text, context, { stream: "stdout" });
	};
	try {
		const shellCommand =
			typeof command === "string" ? command : command.map(shellQuote).join(" ");
		const result = await sandbox.exec(shellCommand, {
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

/** Resolves `path` against `root` and rejects anything outside it. */
function resolveSandboxPath(root: string, path: string): string {
	const normalizedRoot = normalizeRoot(root);
	const resolved = posix.resolve(normalizedRoot, path);
	const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
	if (resolved !== normalizedRoot && !resolved.startsWith(prefix)) {
		throw new Error(`Path escapes the sandbox working directory: ${path}`);
	}
	return resolved;
}

function normalizeRoot(path: string): string {
	if (!posix.isAbsolute(path)) {
		throw new Error(
			`sandbox cwd must be an absolute POSIX path, received ${path}`,
		);
	}
	return posix.normalize(path);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
