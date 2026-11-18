import { posix } from "node:path";
import {
	type CreateVmOptions,
	Freestyle,
	FreestyleApiError,
	type Vm,
} from "freestyle";
import type {
	Sandbox,
	SandboxActorContext,
	SandboxExecOptions,
	SandboxExecResult,
	SandboxProvider,
} from "./index.js";

export interface FreestyleProviderOptions {
	/** Defaults to `new Freestyle()`, which reads `FREESTYLE_API_KEY`. */
	client?: Freestyle;
	/**
	 * Options for `vms.create`, or a function that returns them for the owning
	 * Actor. A VM has no network access unless `firewall` allows it. The image
	 * must include Python 3, which every `freestyle/ubuntu*` snapshot has.
	 */
	create:
		| CreateVmOptions
		| ((c: SandboxActorContext) => CreateVmOptions | Promise<CreateVmOptions>);
	/** Working directory inside the VM, created when the Actor connects. Defaults to `/workspace`. */
	cwd?: string;
}

/** Runs an agent's file and shell tools in a Freestyle VM. The VM is paused while the actor sleeps. */
export function freestyleProvider(
	options: FreestyleProviderOptions,
): SandboxProvider {
	const cwd = posix.normalize(options.cwd ?? "/workspace");
	if (!posix.isAbsolute(cwd))
		throw new Error(`freestyle cwd must be an absolute path, received ${cwd}`);
	let client = options.client;
	const freestyle = () => {
		client ??= new Freestyle();
		return client;
	};
	return {
		name: "freestyle",
		cwd,
		create: async (c) => {
			const create =
				typeof options.create === "function"
					? await options.create(c)
					: options.create;
			return (await freestyle().vms.create(create)).vmId;
		},
		connect: async (_c, id) => {
			const vm = freestyle().vms.ref(id);
			try {
				if ((await vm.data()).state !== "running") await vm.start();
			} catch (error) {
				if (isMissingVm(error)) return undefined;
				throw error;
			}
			await vm.fs.mkdir(cwd);
			return freestyleSandbox(vm, cwd);
		},
		suspend: async (_c, id) => {
			await ignoreMissingVm(freestyle().vms.ref(id).pause());
		},
		destroy: async (_c, id) => {
			await ignoreMissingVm(freestyle().vms.delete(id));
		},
	};
}

function freestyleSandbox(vm: Vm, cwd: string): Sandbox {
	return {
		cwd,
		exec: (command, options) => exec(vm, command, options),
		readFile: (path) => vm.fs.readFile(path),
		writeFile: (path, content) => vm.fs.writeFile(path, content),
		mkdir: (path) => vm.fs.mkdir(path),
		stat: async (path) => ({
			isDirectory: (await vm.fs.stat(path)).isDirectory,
		}),
		readdir: async (path) =>
			(await vm.fs.readDir(path)).map((entry) => entry.name),
		exists: (path) => vm.fs.exists(path),
	};
}

function isMissingVm(error: unknown): boolean {
	return (
		error instanceof FreestyleApiError &&
		error.status === 404 &&
		error.code === "NOT_FOUND"
	);
}

async function ignoreMissingVm(operation: Promise<unknown>): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (!isMissingVm(error)) throw error;
	}
}

/**
 * Runs inside the VM's terminal session and reports the command's output as
 * one JSON frame per line. `vm.exec` cannot stream output or stop a command,
 * so commands run in a terminal session instead. A terminal echoes input,
 * rewrites newlines, and merges stderr into stdout, so this bridge puts the
 * terminal in raw mode and base64-encodes each stream. The command, working
 * directory, and environment arrive on stdin, not in the session URL.
 */
const PROCESS_BRIDGE = `
import base64, json, os, selectors, subprocess, sys, tty
tty.setraw(sys.stdin.fileno())
def emit(value):
    print(json.dumps(value), flush=True)
emit(["ready"])
try:
    config = json.loads(sys.stdin.readline())
    process = subprocess.Popen(
        ["/bin/sh", "-c", config["command"]],
        cwd=config["cwd"], env={**os.environ, **config.get("env", {})},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    while selector.get_map():
        for key, _ in selector.select():
            data = os.read(key.fileobj.fileno(), 8192)
            if data:
                emit([key.data, base64.b64encode(data).decode("ascii")])
            else:
                selector.unregister(key.fileobj)
                key.fileobj.close()
    selector.close()
    code = process.wait()
    emit(["exit", code if code >= 0 else None])
except Exception as error:
    emit(["error", str(error)])
`;

/** Bridge frames are a few KiB at most. A longer line means the bridge did not start. */
const MAX_FRAME_LENGTH = 128 * 1024;
/** Terminal input is written in chunks this size, so a large command or environment fits. */
const INPUT_CHUNK_BYTES = 4096;

type PtySession = Awaited<ReturnType<Vm["pty"]["open"]>>;

async function exec(
	vm: Vm,
	command: string,
	options: SandboxExecOptions,
): Promise<SandboxExecResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const ready = deferred<void>();
	const done = deferred<number | null>();
	// Session events can reject `done` before anything awaits it.
	done.promise.catch(() => {});
	let settled = false;
	let timedOut = false;
	let pending = "";
	let session: PtySession | undefined;
	let timer: NodeJS.Timeout | undefined;
	const settle = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		done.resolve(exitCode);
	};
	const fail = (error: unknown) => {
		if (settled) return;
		settled = true;
		done.reject(error);
	};
	const abort = () => fail(new Error("aborted"));
	const onFrame = ([kind, value]: [string, unknown]) => {
		if (kind === "ready") ready.resolve();
		else if (
			(kind === "stdout" || kind === "stderr") &&
			typeof value === "string"
		) {
			const chunk = Buffer.from(value, "base64");
			(kind === "stdout" ? stdout : stderr).push(chunk);
			options.onData?.(chunk);
		} else if (kind === "exit" && (value === null || Number.isInteger(value)))
			settle(value as number | null);
		else if (kind === "error")
			fail(new Error(`freestyle command failed to start: ${String(value)}`));
		else throw new Error(`unexpected frame ${kind}`);
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		session = await vm.pty.open({
			linuxUser: "root",
			exec: `exec python3 -u -c ${shellQuote(PROCESS_BRIDGE)}`,
			onData: (bytes) => {
				if (settled) return;
				try {
					// Every frame is ASCII, including the base64 output.
					pending += Buffer.from(bytes).toString("ascii");
					let newline = pending.indexOf("\n");
					while (newline !== -1 && !settled) {
						onFrame(JSON.parse(pending.slice(0, newline)));
						pending = pending.slice(newline + 1);
						newline = pending.indexOf("\n");
					}
					if (pending.length > MAX_FRAME_LENGTH)
						throw new Error("frame too long");
				} catch (error) {
					fail(
						new Error(
							"freestyle command bridge failed. The VM image must include Python 3.",
							{ cause: error },
						),
					);
				}
			},
			onExit: () =>
				fail(
					new Error(
						"freestyle command bridge exited without a result. The VM image must include Python 3.",
					),
				),
			onClose: ({ code, reason }) =>
				fail(
					new Error(
						`freestyle terminal session closed before the command ended (${code}: ${reason})`,
					),
				),
			onError: fail,
		});
		if (options.timeoutMs) {
			timer = setTimeout(() => {
				timedOut = !settled;
				settle(null);
			}, options.timeoutMs);
		}
		await Promise.race([ready.promise, done.promise]);
		if (!settled) {
			const input = Buffer.from(
				`${JSON.stringify({ command, cwd: options.cwd, env: options.env })}\n`,
			);
			for (let offset = 0; offset < input.length; offset += INPUT_CHUNK_BYTES)
				session.write(input.subarray(offset, offset + INPUT_CHUNK_BYTES));
		}
		const exitCode = await done.promise;
		return {
			exitCode,
			timedOut,
			stdout: Buffer.concat(stdout).toString(),
			stderr: Buffer.concat(stderr).toString(),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (session) await closeSession(vm, session);
	}
}

/**
 * Closing the session kills its process group, including any children the
 * command started. Detaching alone would leave them running.
 */
async function closeSession(vm: Vm, session: PtySession): Promise<void> {
	try {
		await vm.pty.close(session.sessionId, { linuxUser: "root" });
	} catch (error) {
		if (!(error instanceof FreestyleApiError && error.status === 404))
			throw error;
	} finally {
		session.detach();
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
