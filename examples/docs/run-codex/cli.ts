// docs:start command
// The Codex installer puts the CLI in ~/.local/bin.
const CLI = "$HOME/.local/bin/codex";

// Installs the Codex CLI unless this sandbox already has it.
export const INSTALL = `test -x ${CLI} || (curl -fsSL https://chatgpt.com/codex/install.sh | sh)`;

// One run of Codex with no terminal. It prints one JSON event per line.
// Passing the thread id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
	const resume = cliSessionId ? ` resume ${quote(cliSessionId)}` : "";
	return `${CLI} exec --json --skip-git-repo-check --sandbox danger-full-access${resume} ${quote(prompt)}`;
}

// The API key reaches Codex as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
	return { CODEX_API_KEY: required("CODEX_API_KEY") };
}
// docs:end command

// docs:start events
// The fields of Codex's JSON events that this example reads.
export interface CliEvent {
	type: string;
	thread_id?: string;
	item?: { type: string; text?: string };
}

// The first event, `thread.started`, names the thread. Each finished agent message is text, and the last one is the answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
	return {
		cliSessionId: event.type === "thread.started" ? event.thread_id : undefined,
		answer: event.type === "item.completed" && event.item?.type === "agent_message" ? event.item.text : undefined,
	};
}
// docs:end events

// Quotes a value for the sandbox's shell.
function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} on the worker.`);
	return value;
}
