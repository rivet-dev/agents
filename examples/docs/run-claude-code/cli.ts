// docs:start command
// Claude Code's installer puts the CLI in ~/.local/bin.
const CLI = "$HOME/.local/bin/claude";

// Installs Claude Code unless this sandbox already has it.
export const INSTALL = `test -x ${CLI} || (curl -fsSL https://claude.ai/install.sh | bash)`;

// One run of Claude Code with no terminal. It prints one JSON event per line.
// Passing the session id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
	const resume = cliSessionId ? ` --resume ${quote(cliSessionId)}` : "";
	return `${CLI} -p ${quote(prompt)} --output-format stream-json --verbose --dangerously-skip-permissions${resume}`;
}

// The API key reaches Claude Code as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
	return { ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY") };
}
// docs:end command

// docs:start events
// The fields of Claude Code's JSON events that this example reads.
export interface CliEvent {
	type: string;
	session_id?: string;
	result?: string;
}

// Every event carries the session id. The last event, `result`, holds the final answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
	return {
		cliSessionId: event.session_id,
		answer: event.type === "result" ? event.result : undefined,
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
