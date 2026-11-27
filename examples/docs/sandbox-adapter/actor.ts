import { posix } from "node:path";
import type { Sandbox, SandboxActorContext } from "@rivet-dev/sandbox-adapter";
import { dockerProvider } from "@rivet-dev/sandbox-adapter/docker";
import { actor, event, setup } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";

// One provider object serves every Actor of this definition.
const provider = dockerProvider({ image: "ubuntu:24.04" });

export const build = actor({
	// Saves the id of this Actor's sandbox.
	db: db({
		onMigrate: async (db) => {
			await db.execute("CREATE TABLE IF NOT EXISTS sandbox (id INTEGER PRIMARY KEY CHECK (id = 1), sandbox_id TEXT)");
			await db.execute("INSERT OR IGNORE INTO sandbox (id) VALUES (1)");
		},
	}),
	events: {
		// Command output, as it arrives.
		output: event<string>(),
	},
	actions: {
		run: async (c, command: string) => {
			const sandbox = await openSandbox(c);
			const decoder = new TextDecoder();
			return sandbox.exec(command, {
				cwd: sandbox.cwd,
				timeoutMs: 60_000,
				// Stops the command if the Actor shuts down.
				signal: c.abortSignal,
				onData: (chunk) => c.broadcast("output", decoder.decode(chunk, { stream: true })),
			});
		},
		saveFile: async (c, path: string, content: string) => {
			const sandbox = await openSandbox(c);
			const target = posix.resolve(sandbox.cwd, path);
			await sandbox.mkdir(posix.dirname(target));
			await sandbox.writeFile(target, content);
		},
		readFile: async (c, path: string) => {
			const sandbox = await openSandbox(c);
			const bytes = await sandbox.readFile(posix.resolve(sandbox.cwd, path));
			return new TextDecoder().decode(bytes);
		},
	},
	// The sandbox stops while the Actor sleeps and is removed along with the Actor.
	onSleep: async (c) => {
		const sandboxId = await savedSandboxId(c.db);
		if (sandboxId) await provider.suspend?.(c, sandboxId);
	},
	onDestroy: async (c) => {
		const sandboxId = await savedSandboxId(c.db);
		if (sandboxId) await provider.destroy?.(c, sandboxId);
	},
});

// Connects to this Actor's sandbox. The first call creates it.
async function openSandbox(c: SandboxActorContext & { db: RawAccess }): Promise<Sandbox> {
	const sandboxId = await savedSandboxId(c.db);
	const existing = sandboxId ? await provider.connect(c, sandboxId) : undefined;
	if (existing) return existing;
	const created = await provider.create(c);
	await c.db.execute("UPDATE sandbox SET sandbox_id = ? WHERE id = 1", created);
	const sandbox = await provider.connect(c, created);
	if (!sandbox) throw new Error(`Sandbox ${created} was not found right after it was created.`);
	return sandbox;
}

async function savedSandboxId(db: RawAccess): Promise<string | null> {
	const [row] = await db.execute<{ sandbox_id: string | null }>("SELECT sandbox_id FROM sandbox WHERE id = 1");
	return row?.sandbox_id ?? null;
}

export const registry = setup({ use: { build } });

registry.start();
