import type { Sandbox, SandboxActorContext } from "@rivet-dev/sandbox-adapter";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { actor, event, UserError } from "rivetkit";
import { type CliEvent, cliEnv, command, INSTALL, readEvent } from "./cli";

// A coding task can run for many minutes. The CLI is stopped at this limit.
const PROMPT_TIMEOUT_MS = 30 * 60_000;

// docs:start provider
// E2B pauses the sandbox while the Actor sleeps. The timeout keeps it running through a long task.
const provider = e2bProvider({ create: { timeoutMs: 60 * 60_000 } });
// docs:end provider

// docs:start state
interface Turn {
	role: "user" | "assistant";
	text: string;
}

interface SessionState {
	sandboxId: string | null;
	cliSessionId: string | null;
	transcript: Turn[];
}

// One per session, keyed by your session id.
export const opencodeSession = actor({
	state: { sandboxId: null, cliSessionId: null, transcript: [] } as SessionState,
	events: {
		// Each JSON event OpenCode prints, as it arrives.
		output: event<CliEvent>(),
	},
	// Set while a prompt runs, so a second prompt can't start a second CLI in the same sandbox.
	createVars: () => ({ running: false }),
	options: { actionTimeout: PROMPT_TIMEOUT_MS + 60_000 },
	// docs:end state
	actions: {
		// docs:start prompt
		// Runs one prompt and returns the final answer. Events reach connected clients as they arrive.
		prompt: async (c, text: string) => {
			if (c.vars.running) throw new UserError("A prompt is already running in this session.");
			c.vars.running = true;
			try {
				const sandbox = await openSandbox(c, c.state);
				let answer = "";
				const result = await sandbox.exec(command(text, c.state.cliSessionId), {
					cwd: sandbox.cwd,
					env: cliEnv(),
					timeoutMs: PROMPT_TIMEOUT_MS,
					// Stops OpenCode if the Actor shuts down mid-run.
					signal: c.abortSignal,
					onData: jsonLines((event) => {
						const read = readEvent(event);
						if (read.cliSessionId) c.state.cliSessionId = read.cliSessionId;
						if (read.answer !== undefined) answer = read.answer;
						c.broadcast("output", event);
					}),
				});
				if (result.timedOut) throw new UserError("OpenCode ran past the time limit.");
				if (result.exitCode !== 0) {
					throw new UserError(`OpenCode exited with code ${result.exitCode}. ${result.stderr.slice(-2000)}`);
				}
				c.state.transcript.push({ role: "user", text }, { role: "assistant", text: answer });
				return answer;
			} finally {
				c.vars.running = false;
			}
		},
		// docs:end prompt
		getTranscript: (c) => c.state.transcript,
	},
	// docs:start lifecycle
	// The sandbox pauses while the Actor sleeps and is deleted along with the Actor.
	onSleep: async (c) => {
		if (c.state.sandboxId) await provider.suspend?.(c, c.state.sandboxId);
	},
	onDestroy: async (c) => {
		if (c.state.sandboxId) await provider.destroy?.(c, c.state.sandboxId);
	},
	// docs:end lifecycle
});

// docs:start sandbox
// Connects to this session's sandbox. The first prompt creates it.
async function openSandbox(c: SandboxActorContext, state: SessionState): Promise<Sandbox> {
	let sandbox = state.sandboxId ? await provider.connect(c, state.sandboxId) : undefined;
	if (!sandbox) {
		// A new sandbox has none of the earlier files, so the conversation starts over too.
		state.sandboxId = await provider.create(c);
		state.cliSessionId = null;
		sandbox = await provider.connect(c, state.sandboxId);
		if (!sandbox) throw new Error(`Sandbox ${state.sandboxId} was not found right after it was created.`);
	}
	const install = await sandbox.exec(INSTALL, { cwd: sandbox.cwd });
	if (install.exitCode !== 0) {
		throw new Error(`Installing OpenCode failed. ${install.stdout}${install.stderr}`);
	}
	return sandbox;
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
