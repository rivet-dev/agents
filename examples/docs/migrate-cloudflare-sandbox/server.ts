import { posix } from "node:path";
import type { Sandbox, SandboxActorContext } from "@rivet-dev/sandbox-adapter";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { Sandbox as E2BSandbox } from "e2b";
import { actor, event, setup, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";

// docs:start provider
// One provider object serves every Actor of this definition. E2B pauses the
// sandbox while the Actor sleeps, so its files are still there on the next wake.
const provider = e2bProvider({ template: "base" });
// docs:end provider

// docs:start open
interface Vars {
	// The connected sandbox. It exists only in memory, so it is opened again after a wake.
	sandbox: Promise<Sandbox> | null;
	// Background processes started by `startProcess`, keyed by process id.
	processes: Map<string, AbortController>;
}

interface SandboxContext extends SandboxActorContext {
	db: RawAccess;
	vars: Vars;
}

// Returns this Actor's sandbox. The first call creates it. Actions run
// concurrently, so every caller shares one in-flight open.
function openSandbox(c: SandboxContext): Promise<Sandbox> {
	c.vars.sandbox ??= connectOrCreate(c).catch((error: unknown) => {
		c.vars.sandbox = null;
		throw error;
	});
	return c.vars.sandbox;
}

async function connectOrCreate(c: SandboxContext): Promise<Sandbox> {
	const id = await storedSandboxId(c);
	const existing = id ? await provider.connect(c, id) : undefined;
	if (existing) return existing;

	// Store the new id before using the sandbox, so it is never lost.
	const newId = await provider.create(c);
	await c.db.execute(
		"INSERT OR REPLACE INTO sandbox (id, sandbox_id) VALUES (1, ?)",
		newId,
	);
	const sandbox = await provider.connect(c, newId);
	if (!sandbox) throw new Error(`Sandbox ${newId} was not found right after it was created.`);
	return sandbox;
}

async function storedSandboxId(c: SandboxContext): Promise<string | undefined> {
	const rows = await c.db.execute<{ sandbox_id: string }>(
		"SELECT sandbox_id FROM sandbox WHERE id = 1",
	);
	return rows[0]?.sandbox_id;
}
// docs:end open

export interface OutputEvent {
	// Null for `execStream`, or the id `startProcess` returned.
	processId: string | null;
	text: string;
}

export interface ExitEvent {
	processId: string;
	exitCode: number | null;
}

export const sandbox = actor({
	// docs:start definition
	// The sandbox id is the only durable data. It lives in the Actor's SQLite database.
	db: db({
		onMigrate: async (db) => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS sandbox (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					sandbox_id TEXT NOT NULL
				)
			`);
		},
	}),
	createVars: (): Vars => ({ sandbox: null, processes: new Map() }),
	events: {
		// Output of `execStream` and background processes, as it arrives.
		output: event<OutputEvent>(),
		// Sent when a background process ends.
		exit: event<ExitEvent>(),
	},
	options: {
		// Like Cloudflare's `sleepAfter`: sleep after 10 idle minutes.
		sleepTimeout: 10 * 60_000,
		// Commands can run longer than the default 60 second action timeout.
		actionTimeout: 15 * 60_000,
	},
	// docs:end definition
	actions: {
		// docs:start exec
		// Runs one command and waits for it to end. A non-zero exit code is a normal result.
		exec: async (c, command: string) => {
			const box = await openSandbox(c);
			return box.exec(command, {
				cwd: box.cwd,
				timeoutMs: 60_000,
				// Stops the command if the Actor shuts down.
				signal: c.abortSignal,
			});
		},
		// docs:end exec

		// docs:start stream
		// Sends output to connected clients as it arrives, then returns the full result.
		execStream: async (c, command: string) => {
			const box = await openSandbox(c);
			const decoder = new TextDecoder();
			return box.exec(command, {
				cwd: box.cwd,
				timeoutMs: 10 * 60_000,
				signal: c.abortSignal,
				onData: (chunk) =>
					c.broadcast("output", {
						processId: null,
						text: decoder.decode(chunk, { stream: true }),
					}),
			});
		},
		// docs:end stream

		// docs:start process
		// Starts a long-running command, such as a dev server, and returns right away.
		startProcess: async (c, command: string) => {
			const box = await openSandbox(c);
			const processId = crypto.randomUUID();
			const controller = new AbortController();
			c.vars.processes.set(processId, controller);

			const decoder = new TextDecoder();
			const run = box
				.exec(command, {
					cwd: box.cwd,
					// Killed by `killProcess`, or when the Actor shuts down.
					signal: AbortSignal.any([controller.signal, c.abortSignal]),
					onData: (chunk) =>
						c.broadcast("output", {
							processId,
							text: decoder.decode(chunk, { stream: true }),
						}),
				})
				.then(
					(result) => c.broadcast("exit", { processId, exitCode: result.exitCode }),
					() => c.broadcast("exit", { processId, exitCode: null }),
				)
				.finally(() => c.vars.processes.delete(processId));

			// The Actor stays awake while the process runs.
			c.keepAwake(run);
			return processId;
		},
		killProcess: (c, processId: string) => {
			const controller = c.vars.processes.get(processId);
			if (!controller) throw new UserError(`No process ${processId} is running.`);
			controller.abort();
		},
		listProcesses: (c) => [...c.vars.processes.keys()],
		// docs:end process

		// docs:start files
		writeFile: async (c, path: string, content: string) => {
			const box = await openSandbox(c);
			const target = posix.resolve(box.cwd, path);
			await box.mkdir(posix.dirname(target));
			await box.writeFile(target, content);
		},
		readFile: async (c, path: string) => {
			const box = await openSandbox(c);
			const bytes = await box.readFile(posix.resolve(box.cwd, path));
			return new TextDecoder().decode(bytes);
		},
		listFiles: async (c, path = ".") => {
			const box = await openSandbox(c);
			return box.readdir(posix.resolve(box.cwd, path));
		},
		exists: async (c, path: string) => {
			const box = await openSandbox(c);
			return box.exists(posix.resolve(box.cwd, path));
		},
		// Deleting and moving files are shell commands. Passing paths as
		// environment variables keeps them out of the command string.
		deleteFile: async (c, path: string) => {
			const box = await openSandbox(c);
			const result = await box.exec('rm -rf -- "$TARGET"', {
				cwd: box.cwd,
				env: { TARGET: posix.resolve(box.cwd, path) },
			});
			if (result.exitCode !== 0) throw new UserError(result.stderr);
		},
		// docs:end files

		// docs:start git
		// Clones a GitHub repository. The token reaches only this one command.
		gitClone: async (c, repo: string, branch: string, dir: string) => {
			const box = await openSandbox(c);
			const result = await box.exec(
				'git clone --depth 1 --branch "$BRANCH" "https://x-access-token:$GIT_TOKEN@github.com/$REPO.git" "$DIR"',
				{
					cwd: box.cwd,
					timeoutMs: 5 * 60_000,
					env: {
						REPO: repo,
						BRANCH: branch,
						DIR: dir,
						GIT_TOKEN: process.env.GITHUB_TOKEN ?? "",
					},
				},
			);
			if (result.exitCode !== 0) throw new UserError(result.stderr);
		},
		// docs:end git

		// docs:start code
		// Runs a Python snippet. Each run is a fresh process, so variables don't carry over.
		runPython: async (c, code: string) => {
			const box = await openSandbox(c);
			const file = posix.join(box.cwd, ".snippets", `${crypto.randomUUID()}.py`);
			await box.mkdir(posix.dirname(file));
			await box.writeFile(file, code);
			return box.exec('python3 "$FILE"', {
				cwd: box.cwd,
				timeoutMs: 60_000,
				env: { FILE: file },
			});
		},
		// docs:end code

		// docs:start preview
		// Returns a public URL for a port in the sandbox, like Cloudflare's `exposePort`.
		// The adapter has no port API, so this calls the E2B SDK directly.
		previewUrl: async (c, port: number) => {
			await openSandbox(c);
			const id = await storedSandboxId(c);
			if (!id) throw new Error("The sandbox was not created.");
			const box = await E2BSandbox.connect(id);
			return `https://${box.getHost(port)}`;
		},
		// docs:end preview

		// docs:start destroy
		// Like Cloudflare's `destroy()`: deletes the Actor, and `onDestroy` deletes its sandbox.
		destroy: (c) => {
			c.destroy();
		},
		// docs:end destroy
	},
	// docs:start lifecycle
	// Pauses the sandbox while the Actor sleeps.
	onSleep: async (c) => {
		const id = await storedSandboxId(c);
		if (id) await provider.suspend?.(c, id);
	},
	// Deletes the sandbox along with the Actor.
	onDestroy: async (c) => {
		const id = await storedSandboxId(c);
		if (id) await provider.destroy?.(c, id);
	},
	// docs:end lifecycle
});

export const registry = setup({ use: { sandbox } });

registry.start();
