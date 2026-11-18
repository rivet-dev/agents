import type { Sandbox, SandboxActorContext, SandboxProvider } from "@rivet-dev/sandbox-adapter";
import type { Client } from "rivetkit/client";
import type { registry } from "./server";

// docs:start provider
// Outside the workspace, so the agent doesn't commit it.
export const SCRIPT_PATH = "/tmp/call-tool.sh";

// The maximum. The script is rewritten after every wake.
const TOKEN_TTL_SECONDS = 24 * 60 * 60;

// Writes the script into every sandbox the agent connects to.
export function withCallbackScript(provider: SandboxProvider): SandboxProvider {
	return {
		...provider,
		connect: async (c, id) => {
			const sandbox = await provider.connect(c, id);
			if (sandbox) await writeScript(sandbox, c);
			return sandbox;
		},
	};
}

async function writeScript(sandbox: Sandbox, c: SandboxActorContext): Promise<void> {
	// The agent's own client uses your Rivet token. The scoped token reaches only
	// this Actor, but can call every action on it.
	const client = c.client() as Client<typeof registry>;
	const { token } = await client.agent.getForId(c.actorId).issueToken({ subject: "sandbox", expiresIn: TOKEN_TTL_SECONDS });
	await sandbox.writeFile(SCRIPT_PATH, callbackScript(`${gatewayEndpoint()}/gateway/${c.actorId}`, token));
	const chmod = await sandbox.exec(`chmod 700 ${SCRIPT_PATH}`, { cwd: sandbox.cwd });
	if (chmod.exitCode !== 0) throw new Error(`Installing ${SCRIPT_PATH} failed. ${chmod.stderr}`);
}
// docs:end provider

// docs:start script
// Calls one tool (an action on the agent) through the gateway and prints the JSON reply.
function callbackScript(actorUrl: string, token: string): string {
	return `#!/bin/sh
# Usage: ${SCRIPT_PATH} <tool> '<JSON array of arguments>'
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <tool> '<JSON array of arguments>'" >&2; exit 2; }
exec curl -sS --fail-with-body -X POST \\
	-H ${quote(`x-rivet-token: ${token}`)} \\
	-H 'content-type: application/json' \\
	--data "{\\"args\\":\${2:-[]}}" \\
	${quote(`${actorUrl}/action/`)}"$1"
`;
}

// A public gateway address, without your Rivet token.
function gatewayEndpoint(): string {
	const endpoint = process.env.RIVET_PUBLIC_ENDPOINT ?? process.env.RIVET_ENDPOINT;
	if (!endpoint) throw new Error("Set RIVET_PUBLIC_ENDPOINT to an address the sandbox can reach.");
	const url = new URL(endpoint);
	url.username = "";
	url.password = "";
	return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}

// Quotes a value for the sandbox's shell.
function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
// docs:end script
