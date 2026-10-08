import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	LineScanner,
	ok,
	type Result,
	toError,
} from "@earendil-works/pi-durable/env";
import type { PiDatabase } from "./storage.js";

const DEFAULT_CWD = "/workspace";

/** Bytes per query when a scan walks a whole file. */
const SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Pi Durable's `ExecutionEnv` over files stored in the actor's database, in
 * the `pi_file` table, for Pi's `read`, `write`, and `edit` tools. Directories
 * exist only as the paths of their files. There is no shell, so `exec` fails
 * with `shell_unavailable`, and operations the tools do not use return
 * `not_supported`.
 */
export function databaseEnv(
	db: PiDatabase,
	options: { id: string; cwd?: string },
): ExecutionEnv {
	const env: ExecutionEnv = {
		id: options.id,
		cwd: posix.resolve(DEFAULT_CWD, options.cwd ?? DEFAULT_CWD),

		absolutePath: async (path) => ok(posix.resolve(env.cwd, path)),
		joinPath: async (parts) => ok(posix.join(...parts)),
		canonicalPath: async (path) => ok(posix.resolve(env.cwd, path)),
		exists: (path, context) =>
			attempt(
				path,
				context,
				async (resolved) => (await entry(db, resolved)) !== undefined,
			),
		fileInfo: (path, context) =>
			attempt(path, context, async (resolved) => {
				const info = await entry(db, resolved);
				if (!info) throw notFound(resolved);
				return info;
			}),
		readTextFile: (path, context) =>
			attempt(path, context, async (resolved) =>
				new TextDecoder().decode(await readFile(db, resolved)),
			),
		readBinaryFile: (path, context) =>
			attempt(path, context, (resolved) => readFile(db, resolved)),
		openBinaryReader: (path, _options, context) =>
			attempt(path, context, async (resolved) => {
				await requireFile(db, resolved);
				return fileReader(db, resolved);
			}),
		writeFile: (path, content, context) =>
			attempt(path, context, async (resolved) => {
				const bytes =
					typeof content === "string"
						? new TextEncoder().encode(content)
						: content;
				await db.execute(
					`INSERT INTO pi_file (path, content, mtime_ms) VALUES (?, ?, ?)
					 ON CONFLICT (path) DO UPDATE SET
						content = excluded.content,
						mtime_ms = excluded.mtime_ms`,
					resolved,
					bytes,
					Date.now(),
				);
			}),

		exec: async () =>
			err(
				new ExecutionError(
					"shell_unavailable",
					"There is no shell: files are stored in the actor's database. Give pi() a sandbox to run commands.",
				),
			),

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

	/**
	 * Resolves `path`, runs `operation` unless the run is aborted, and returns a
	 * thrown error as a `FileError`.
	 */
	async function attempt<T>(
		path: string,
		context: Context,
		operation: (resolved: string) => Promise<T>,
	): Promise<Result<T, FileError>> {
		const resolved = posix.resolve(env.cwd, path);
		if (context.abortSignal?.aborted) return err(aborted(resolved));
		try {
			return ok(await operation(resolved));
		} catch (error) {
			if (error instanceof FileError) return err(error);
			const cause = toError(error);
			return err(new FileError("unknown", cause.message, resolved, cause));
		}
	}

	return env;
}

/** The file or directory at `path`. A directory exists when a file below it does. */
async function entry(
	db: PiDatabase,
	path: string,
): Promise<FileInfo | undefined> {
	const [file] = await db.execute<{ size: number; mtime_ms: number }>(
		`SELECT length(content) AS size, mtime_ms FROM pi_file WHERE path = ?`,
		path,
	);
	if (file) {
		return {
			name: posix.basename(path),
			path,
			kind: "file",
			size: file.size,
			mtimeMs: file.mtime_ms,
		};
	}
	const below = path === "/" ? "/" : `${path}/`;
	// Paths below `below` sort from it up to the same prefix ending in the next byte.
	const [child] = await db.execute(
		`SELECT 1 FROM pi_file WHERE path > ? AND path < ? LIMIT 1`,
		below,
		`${below.slice(0, -1)}0`,
	);
	if (!child) return undefined;
	return {
		name: posix.basename(path),
		path,
		kind: "directory",
		size: 0,
		mtimeMs: 0,
	};
}

async function requireFile(db: PiDatabase, path: string): Promise<FileInfo> {
	const info = await entry(db, path);
	if (!info) throw notFound(path);
	if (info.kind === "directory") {
		throw new FileError("is_directory", `${path} is a directory`, path);
	}
	return info;
}

async function readFile(db: PiDatabase, path: string): Promise<Uint8Array> {
	const [row] = await db.execute<{ content: Uint8Array }>(
		`SELECT content FROM pi_file WHERE path = ?`,
		path,
	);
	if (row) return new Uint8Array(row.content);
	await requireFile(db, path);
	throw notFound(path);
}

/** Reads byte ranges of the stored file with SQL, so a large file is never loaded whole. */
function fileReader(db: PiDatabase, path: string): BinaryReader {
	const range = async (offset: number, length: number) => {
		const [row] = await db.execute<{ chunk: Uint8Array | null }>(
			`SELECT substr(content, ?, ?) AS chunk FROM pi_file WHERE path = ?`,
			offset + 1,
			length,
			path,
		);
		if (!row) throw notFound(path);
		return new Uint8Array(row.chunk ?? new Uint8Array());
	};
	const guarded = async <T>(
		context: Context,
		operation: () => Promise<T>,
	): Promise<Result<T, FileError>> => {
		if (context.abortSignal?.aborted) return err(aborted(path));
		try {
			return ok(await operation());
		} catch (error) {
			if (error instanceof FileError) return err(error);
			const cause = toError(error);
			return err(new FileError("unknown", cause.message, path, cause));
		}
	};
	return {
		info: (context) => guarded(context, () => requireFile(db, path)),
		read: (offset, length, context) =>
			guarded(context, () => range(offset, length)),
		scanLines: ({ startLine, endLine }, context) =>
			guarded(context, async () => {
				let scanner: LineScanner;
				try {
					scanner = new LineScanner(startLine, endLine);
				} catch {
					throw new FileError("invalid", "Invalid line range", path);
				}
				for (let offset = 0; ; offset += SCAN_CHUNK_BYTES) {
					if (context.abortSignal?.aborted) throw aborted(path);
					const chunk = await range(offset, SCAN_CHUNK_BYTES);
					if (chunk.length > 0) scanner.push(chunk);
					if (chunk.length < SCAN_CHUNK_BYTES) return scanner.finish();
				}
			}),
		close: async () => {},
	};
}

function aborted(path: string): FileError {
	return new FileError("aborted", "aborted", path);
}

function notFound(path: string): FileError {
	return new FileError("not_found", `${path} does not exist`, path);
}

function notSupported<T>(
	operation: string,
	path?: string,
): Result<T, FileError> {
	return err(
		new FileError(
			"not_supported",
			`${operation} is not supported for files stored in the database`,
			path,
		),
	);
}
