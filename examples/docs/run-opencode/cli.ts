// docs:start command
// The OpenCode installer puts the CLI in ~/.opencode/bin.
const CLI = "$HOME/.opencode/bin/opencode";

// Any model OpenCode supports, as provider/model. Set that provider's key in cliEnv.
const MODEL = "anthropic/claude-opus-5-5";

// Installs OpenCode unless this sandbox already has it.
export const INSTALL = `test -x ${CLI} || (curl -fsSL https://opencode.ai/install | bash)`;

// One run of OpenCode with no terminal. It prints one JSON event per line.
// Passing the session id from an earlier run continues that conversation.
export function command(prompt: string, cliSessionId: string | null): string {
	const resume = cliSessionId ? ` --session ${quote(cliSessionId)}` : "";
	return `${CLI} run --format json --auto --model ${MODEL}${resume} ${quote(prompt)}`;
}

// The API key reaches OpenCode as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
	return { ANTHROPIC_API_KEY: required("ANTHROPIC_API_KEY") };
}
// docs:end command

// docs:start events
// The fields of OpenCode's JSON events that this example reads.
export interface CliEvent {
	type: string;
	sessionID?: string;
	part?: { text?: string };
}

// Every event carries the session id. Each `text` event is a finished block of text, and the last one is the answer.
export function readEvent(event: CliEvent): { cliSessionId?: string; answer?: string } {
	return {
		cliSessionId: event.sessionID,
		answer: event.type === "text" ? event.part?.text : undefined,
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
