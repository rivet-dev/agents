import { posix } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	Boxd,
	ConflictError,
	type MachineCreateParams,
	NotFoundError,
} from "@boxd-sh/sdk";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

export interface BoxdProviderOptions {
	/** Defaults to `new Boxd()`, which reads `BOXD_API_KEY`. */
	client?: Boxd;
	/**
	 * Options for `machines.create`, or a function that returns them for the
	 * owning Actor. Defaults to a machine from the default image in the
	 * organization's default size.
	 */
	create?:
		| MachineCreateParams
		| ((
				c: SandboxActorContext,
		  ) => MachineCreateParams | Promise<MachineCreateParams>);
	/** Working directory inside the machine, created when the Actor connects. Defaults to `/home/boxd`. */
	cwd?: string;
}

/** Runs an agent's file and shell tools in a boxd machine. The machine is hibernated while the actor sleeps. */
export function boxdProvider(
	options: BoxdProviderOptions = {},
): SandboxProvider {
	const cwd = posix.normalize(options.cwd ?? "/home/boxd");
	if (!posix.isAbsolute(cwd))
		throw new Error(`boxd cwd must be an absolute path, received ${cwd}`);
	let client = options.client;
	const boxd = () => {
		client ??= new Boxd();
		return client;
	};
	return {
		name: "boxd",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: options.create;
			return (await boxd().machines.create(create)).id;
		},
		connect: async (_c, id) => {
			const machines = boxd().machines;
			try {
				const { status } = await machines.get(id);
				if (status === "destroyed") return undefined;
				if (status === "suspended") await machines.resume(id);
				else if (status === "hibernated") await machines.wake(id);
				else if (status === "stopped") await machines.start(id);
				await machines.waitUntilReady(id);
			} catch (error) {
				if (error instanceof NotFoundError) return undefined;
				throw error;
			}
			await machines.fs.mkdir(id, cwd);
			return boxdSandbox(boxd(), id, cwd);
		},
		suspend: async (_c, id) => {
			const machines = boxd().machines;
			try {
				await ignoreMissingMachine(machines.hibernate(id));
			} catch (error) {
				// A stopped machine already uses no compute, so it stays stopped.
				if (
					error instanceof ConflictError &&
					(await machines.get(id)).status === "stopped"
				)
					return;
				throw error;
			}
		},
		destroy: async (_c, id) => {
			await ignoreMissingMachine(boxd().machines.delete(id));
		},
	};
}

function boxdSandbox(boxd: Boxd, id: string, cwd: string): Sandbox {
	const fs = boxd.machines.fs;
	return {
		cwd,
		exec: (command, options) => exec(boxd, id, command, options),
		readFile: (path) => fs.read(id, path),
		writeFile: async (path, content) => {
			await fs.write(id, path, content);
		},
		mkdir: (path) => fs.mkdir(id, path),
		stat: async (path) => ({ isDirectory: (await fs.stat(id, path)).isDir }),
		readdir: async (path) =>
			(await fs.list(id, path)).map((entry) => entry.name),
		exists: (path) => fs.exists(id, path),
	};
}

async function ignoreMissingMachine(
	operation: Promise<unknown>,
): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (!(error instanceof NotFoundError)) throw error;
	}
}

/** How long a closed command may take to report its end before `exec` returns without it. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Streams one command through boxd's exec call. Closing the call makes boxd
 * kill the command's process group, so a timeout or an abort stops the
 * command and its children.
 */
async function exec(
	boxd: Boxd,
	id: string,
	command: string,
	options: SandboxExecOptions,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	const stream = boxd.machines.streamExec(id, {
		command: commandLine(command, options),
		closeStdin: true,
	});
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	let closed: "timeout" | "aborted" | undefined;
	let onClosed = () => {};
	const whenClosed = new Promise<void>((resolve) => {
		onClosed = resolve;
	});
	const close = (reason: "timeout" | "aborted") => {
		closed ??= reason;
		stream.close();
		onClosed();
	};
	const collect = async (
		source: AsyncIterable<Uint8Array>,
		into: Uint8Array[],
	) => {
		for await (const chunk of source) {
			into.push(chunk);
			options.onData?.(chunk);
		}
	};
	const abort = () => close("aborted");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = options.timeoutMs
		? setTimeout(() => close("timeout"), options.timeoutMs)
		: undefined;
	try {
		const finished = Promise.all([
			stream.wait(),
			collect(stream.stdout, stdout),
			collect(stream.stderr, stderr),
		]).then(
			([exitCode]) => exitCode,
			(error: unknown) => {
				// Closing the call rejects the stream. That is the expected end of a timeout or abort.
				if (closed) return null;
				throw error;
			},
		);
		// After a timeout or an abort, wait at most CLOSE_GRACE_MS for the call to end.
		const exitCode = await Promise.race([
			finished,
			whenClosed.then(() => delay(CLOSE_GRACE_MS)).then(() => null),
		]);
		if (closed === "aborted") throw new Error("aborted");
		return {
			exitCode: closed === "timeout" ? null : exitCode,
			timedOut: closed === "timeout",
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}

/** Runs `command` in its own `/bin/sh -c` in `options.cwd`, with `options.env` set for all of it. */
function commandLine(command: string, options: SandboxExecOptions): string {
	const env = Object.entries(options.env ?? {}).map(([key, value]) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
			throw new Error(`invalid environment variable name: ${key}`);
		return shellQuote(`${key}=${value}`);
	});
	const run = ["exec", ...(env.length ? ["env", ...env] : []), "/bin/sh", "-c"];
	return `cd ${shellQuote(options.cwd)} && ${run.join(" ")} ${shellQuote(command)}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
