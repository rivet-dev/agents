import { createClient } from "rivetkit/client";
import type { ExitEvent, OutputEvent, registry } from "./server";

const client = createClient<typeof registry>();

// docs:start handle
// Like `getSandbox(env.Sandbox, "user-123")`: the same key always reaches the
// same Actor, and the sandbox starts on the first call that needs it.
const sandbox = client.sandbox.getOrCreate(["user-123"]);

const result = await sandbox.exec("python3 --version");
console.log(result.exitCode, result.stdout);
// docs:end handle

// docs:start stream
// Connect to receive output events while a command runs.
const conn = sandbox.connect();
conn.on("output", (event) => {
	const { id, text } = event as OutputEvent;
	process.stdout.write(`[${id}] ${text}`);
});
conn.on("exit", (event) => {
	const { id, exitCode } = event as ExitEvent;
	console.log(`\n${id} exited with ${exitCode}`);
});

await conn.writeFile("app/main.py", 'print("hello from the sandbox")');
// Each stream gets its own id, so concurrent commands' output can be told apart.
await conn.execStream("python3 app/main.py", "run-main");

// Start a server in the background and open it in a browser.
const processId = await conn.startProcess("python3 -m http.server 8000");
console.log(await conn.previewUrl(8000));
await conn.killProcess(processId);

await conn.dispose();
// docs:end stream
