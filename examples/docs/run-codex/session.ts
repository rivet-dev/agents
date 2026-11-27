import type { Sandbox, SandboxActorContext } from "@rivet-dev/sandbox-adapter";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { actor, event, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { type CliEvent, cliEnv, command, INSTALL, readEvent } from "./cli";

// A coding task can run for many minutes. The CLI is stopped at this limit.
const PROMPT_TIMEOUT_MS = 30 * 60_000;

// docs:start provider
// E2B pauses the sandbox while the Actor sleeps. The timeout keeps it running through a long task.
const provider = e2bProvider({ create: { timeoutMs: 60 * 60_000 } });
// docs:end provider

// docs:start db
type Turn = {
	role: "user" | "assistant";
	text: string;
};

// One per session, keyed by your session id.
export const codexSession = actor({
	db: db({
		onMigrate: async (db) => {
			await db.execute(
				"CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK (id = 1), sandbox_id TEXT, cli_session_id TEXT)",
			);
			await db.execute("INSERT OR IGNORE INTO session (id) VALUES (1)");
			await db.execute(
				"CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL)",
			);
		},
	}),
	events: {
		// Each JSON event Codex prints, as it arrives.
		output: event<CliEvent>(),
	},
	// Set while a prompt runs, so a second prompt can't start a second CLI in the same sandbox.
	createVars: () => ({ running: false }),
	options: { actionTimeout: PROMPT_TIMEOUT_MS + 60_000 },
	// docs:end db
	actions: {
		// docs:start prompt
		// Runs one prompt and returns the final answer. Events reach connected clients as they arrive.
		prompt: async (c, text: string) => {
			if (c.vars.running) throw new UserError("A prompt is already running in this session.");
			c.vars.running = true;
			try {
				const sandbox = await openSandbox(c);
				const [session] = await c.db.execute<{ cli_session_id: string | null }>(
					"SELECT cli_session_id FROM session WHERE id = 1",
				);
				let cliSessionId = session?.cli_session_id ?? null;
				let answer = "";
				const result = await sandbox.exec(command(text, cliSessionId), {
					cwd: sandbox.cwd,
					env: cliEnv(),
					timeoutMs: PROMPT_TIMEOUT_MS,
					// Stops Codex if the Actor shuts down mid-run.
					signal: c.abortSignal,
					onData: jsonLines((event) => {
						const read = readEvent(event);
						if (read.cliSessionId && read.cliSessionId !== cliSessionId) {
							cliSessionId = read.cliSessionId;
							c.waitUntil(c.db.execute("UPDATE session SET cli_session_id = ? WHERE id = 1", cliSessionId));
						}
						if (read.answer !== undefined) answer = read.answer;
						c.broadcast("output", event);
					}),
				});
				if (result.timedOut) throw new UserError("Codex ran past the time limit.");
				if (result.exitCode !== 0) {
					throw new UserError(`Codex exited with code ${result.exitCode}. ${result.stderr.slice(-2000)}`);
				}
				await c.db.execute(
					"INSERT INTO transcript (role, text) VALUES ('user', ?), ('assistant', ?)",
					text,
					answer,
				);
				return answer;
			} finally {
				c.vars.running = false;
			}
		},
		// docs:end prompt
		getTranscript: (c) => c.db.execute<Turn>("SELECT role, text FROM transcript ORDER BY id"),
	},
	// docs:start lifecycle
	// The sandbox pauses while the Actor sleeps and is deleted along with the Actor.
	onSleep: async (c) => {
		const sandboxId = await savedSandboxId(c.db);
		if (sandboxId) await provider.suspend?.(c, sandboxId);
	},
	onDestroy: async (c) => {
		const sandboxId = await savedSandboxId(c.db);
		if (sandboxId) await provider.destroy?.(c, sandboxId);
	},
	// docs:end lifecycle
});

// docs:start sandbox
// Connects to this session's sandbox. The first prompt creates it.
async function openSandbox(c: SandboxActorContext & { db: RawAccess }): Promise<Sandbox> {
	const sandboxId = await savedSandboxId(c.db);
	let sandbox = sandboxId ? await provider.connect(c, sandboxId) : undefined;
	if (!sandbox) {
		// A new sandbox has none of the earlier files, so the conversation starts over too.
		const created = await provider.create(c);
		await c.db.execute("UPDATE session SET sandbox_id = ?, cli_session_id = NULL WHERE id = 1", created);
		sandbox = await provider.connect(c, created);
		if (!sandbox) throw new Error(`Sandbox ${created} was not found right after it was created.`);
	}
	const install = await sandbox.exec(INSTALL, { cwd: sandbox.cwd });
	if (install.exitCode !== 0) {
		throw new Error(`Installing Codex failed. ${install.stdout}${install.stderr}`);
	}
	return sandbox;
}

async function savedSandboxId(db: RawAccess): Promise<string | null> {
	const [session] = await db.execute<{ sandbox_id: string | null }>("SELECT sandbox_id FROM session WHERE id = 1");
	return session?.sandbox_id ?? null;
}
// docs:end sandbox

// Splits streamed output into lines and parses the JSON ones. stderr shares the stream, so other lines are skipped.
function jsonLines(onEvent: (event: CliEvent) => void): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let pending = "";
	return (chunk) => {
		pending += decoder.decode(chunk, { stream: true });
		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof parsed === "object" && parsed !== null) onEvent(parsed as CliEvent);
		}
	};
}
