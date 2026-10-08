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
 * (`CodingTools`). Paths outside `root` are rejected, and commands never
 * receive the actor host's environment variables.
 *
 * Only the operations Pi's tools use are supported. Every other operation
 * returns a `not_supported` error. Operations return failures instead of
 * throwing. Building the environment throws when `root` is not absolute or
 * `cwd` is outside it. `connect` runs on the first operation that needs the
 * sandbox, so a tool that never touches files or the shell never connects it.
 */
export function sandboxEnv(
	connect: () => Promise<Sandbox>,
	options: {
		id: string;
		/** The sandbox directory every path must stay inside. */
		root: string;
		/** The starting working directory. Defaults to `root`. */
		cwd?: string;
	},
): ExecutionEnv {
	const root = checkedRoot(options.root);
	const initialCwd = resolveInside(root, options.cwd ?? root);
	if (!initialCwd.ok) throw initialCwd.error;

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
	/** Runs a file operation on `path` once it is known to be inside the sandbox. */
	const onFile = async <T>(
		path: string,
		context: Context,
		run: (sandbox: Sandbox, target: string) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> => {
		const target = resolveInside(root, path);
		if (!target.ok) return target;
		return withSandbox(
			context,
			(cause) =>
				new FileError(
					context.abortSignal?.aborted ? "aborted" : "unknown",
					cause.message,
					target.value,
					cause,
				),
			(sandbox) => run(sandbox, target.value),
		);
	};

	const env: ExecutionEnv = {
		id: options.id,
		cwd: initialCwd.value,

		absolutePath: async (path) =>
			resolveInside(root, posix.resolve(env.cwd, path)),
		joinPath: async (parts) => ok(posix.join(...parts)),
		exists: (path, context) =>
			onFile(path, context, (sandbox, target) =>
				onPath(target, () => sandbox.exists(target)),
			),
		readTextFile: (path, context) =>
			onFile(path, context, (sandbox, target) =>
				read(sandbox, target, async () =>
					new TextDecoder().decode(await sandbox.readFile(target)),
				),
			),
		readBinaryFile: (path, context) =>
			onFile(path, context, (sandbox, target) =>
				read(sandbox, target, () => sandbox.readFile(target)),
			),
		// The sandbox reads whole files, so the reader holds the file it opened.
		openBinaryReader: (path, _options, context) =>
			onFile(path, context, async (sandbox, target) => {
				const info = await fileInfo(sandbox, target);
				if (!info.ok) return info;
				if (info.value.kind === "directory") {
					return err(
						new FileError("is_directory", `${path} is a directory`, target),
					);
				}
				const bytes = await read(sandbox, target, () =>
					sandbox.readFile(target),
				);
				if (!bytes.ok) return bytes;
				return ok(
					bufferReader(
						{ ...info.value, size: bytes.value.length },
						bytes.value,
					),
				);
			}),
		writeFile: async (path, content, context) => {
			if (typeof content !== "string") {
				return notSupported("writing binary content", path);
			}
			return onFile(path, context, (sandbox, target) =>
				onPath(target, async () => {
					await sandbox.mkdir(posix.dirname(target));
					await sandbox.writeFile(target, content);
				}),
			);
		},
		fileInfo: (path, context) =>
			onFile(path, context, (sandbox, target) => fileInfo(sandbox, target)),
		// Pi's tools fall back to the absolute path when canonical paths are not supported.
		canonicalPath: async (path) => notSupported("canonicalPath", path),

		exec: async (command, options, context) => {
			const cwd = resolveInside(root, options?.cwd ?? env.cwd);
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

/** Runs a sandbox operation on `path` and returns its failure as a `FileError`. */
async function onPath<T>(
	path: string,
	operation: () => Promise<T>,
): Promise<Result<T, FileError>> {
	try {
		return ok(await operation());
	} catch (error) {
		const cause = toError(error);
		return err(new FileError("unknown", cause.message, path, cause));
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

/** Resolves `path` against `root`, an absolute normalized path, and refuses anything outside it. */
function resolveInside(root: string, path: string): Result<string, FileError> {
	const resolved = posix.resolve(root, path);
	const prefix = root === "/" ? "/" : `${root}/`;
	if (resolved !== root && !resolved.startsWith(prefix)) {
		return err(
			new FileError(
				"permission_denied",
				`Path escapes the sandbox working directory: ${path}`,
				path,
			),
		);
	}
	return ok(resolved);
}

/** Normalizes the sandbox root once, when the env is built. */
function checkedRoot(root: string): string {
	if (!posix.isAbsolute(root)) {
		throw new Error(
			`sandbox root must be an absolute POSIX path, received ${root}`,
		);
	}
	return posix.resolve(root);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
