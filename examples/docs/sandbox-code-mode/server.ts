import { execFileSync } from "node:child_process";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { dockerProvider } from "@rivet-dev/sandbox-adapter/docker";
import { event, setup, UserError } from "rivetkit";
import { SCRIPT_PATH, withCallbackScript } from "./callback";
import { readingsPage, SENSORS } from "./readings";

// Builds the sandbox image from ./Dockerfile. Docker caches it after the first run.
console.log("Building the sandbox image...");
execFileSync("docker", ["build", "--quiet", "--tag", "sandbox-code-mode", import.meta.dirname], {
	stdio: ["ignore", "ignore", "inherit"],
});

// Local runs only. Without RIVET_ENDPOINT, RivetKit starts a control plane on
// this machine, so point call-tool.sh at an address the Docker sandbox can reach.
if (!process.env.RIVET_ENDPOINT && !process.env.RIVET_PUBLIC_ENDPOINT) {
	const port = process.env.RIVET_RUN_ENGINE_PORT ?? "6420";
	if (process.platform === "linux") {
		// The sandbox reaches the host through Docker's bridge, so listen beyond loopback.
		process.env.RIVET_RUN_ENGINE_HOST ??= "0.0.0.0";
		process.env.RIVET_PUBLIC_ENDPOINT = `http://172.17.0.1:${port}`;
	} else {
		// Docker Desktop forwards host.docker.internal to the host's loopback.
		process.env.RIVET_PUBLIC_ENDPOINT = `http://host.docker.internal:${port}`;
	}
}

// docs:start prompt
// Coding tools run in the sandbox. The section tells the model about the script.
const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(
	defineExtension({
		name: "agent-callbacks",
		sections: [
			section(
				"agent_callbacks",
				() => `To call the app that runs you, use bash to run:
${SCRIPT_PATH} <tool> '<JSON array of arguments>'
It prints {"output": <result>}, or exits non-zero with an error.

Tools:
- progress ["<message>"]: Shows the user a one-line status. Call it as you start each step of a task.
- saveNote ["<text>"]: Saves a note that is kept after the sandbox is deleted.
- listNotes []: Returns every saved note.
- getReadings ["<sensor>", <cursor>]: Returns {"readings": [...], "next": <cursor or null>}, 1,000 readings a page, one a minute for a week. Start at cursor 0. Sensors: ${SENSORS.join(", ")}.

Example: ${SCRIPT_PATH} progress '["Running the tests"]'`,
			),
		],
	}),
);
// docs:end prompt

// docs:start agent
export const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	// Writes call-tool.sh into the sandbox. The image has curl, Node.js, and Python with numpy.
	// Docker is only for local development, where the sandbox can reach the control plane
	// on this machine. In production, switch to a hosted sandbox provider such as Daytona
	// or E2B, and set RIVET_PUBLIC_ENDPOINT to an address the sandbox can reach.
	sandbox: withCallbackScript(dockerProvider({ image: "sandbox-code-mode" })),
	state: { notes: [] as string[] },
	events: {
		progress: event<string>(),
	},
	// The tools call-tool.sh calls. Each one is an action on the agent.
	actions: {
		progress: (c, message: unknown) => {
			c.broadcast("progress", requireText(message));
			return null;
		},
		saveNote: (c, text: unknown) => {
			c.state.notes.push(requireText(text));
			return { saved: c.state.notes.length };
		},
		listNotes: (c) => c.state.notes,
		// In a real app, this queries your metrics database with your keys.
		getReadings: (_c, sensor: unknown, cursor: unknown) => readingsPage(sensor, cursor),
	},
});

function requireText(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new UserError("Pass a non-empty string.");
	return value;
}
// docs:end agent

export const registry = setup({ use: { agent } });

registry.start();
