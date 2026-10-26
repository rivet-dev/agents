// docs:start command
// The Amp installer puts the CLI in ~/.amp/bin.
const CLI = "$HOME/.amp/bin/amp";

// Installs the Amp CLI unless this sandbox already has it.
export const INSTALL = `test -x ${CLI} || (curl -fsSL https://ampcode.com/install.sh | bash)`;

// One run of Amp in execute mode. It prints one JSON event per line.
// Passing the thread id from an earlier run continues that thread.
export function command(prompt: string, cliSessionId: string | null): string {
	const resume = cliSessionId ? ` threads continue ${quote(cliSessionId)}` : "";
	return `${CLI}${resume} -x ${quote(prompt)} --stream-json`;
}

// The access token reaches Amp as an environment variable of this one process.
export function cliEnv(): Record<string, string> {
	return { AMP_API_KEY: required("AMP_API_KEY") };
}
// docs:end command

// docs:start events
// The fields of Amp's JSON events that this example reads.
export interface CliEvent {
	type: string;
	session_id?: string;
	result?: string;
}

// Every event carries the thread id. The last event, `result`, holds the final answer.
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
