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
	process.stdout.write((event as OutputEvent).text);
});
conn.on("exit", (event) => {
	const { processId, exitCode } = event as ExitEvent;
	console.log(`\n${processId} exited with ${exitCode}`);
});

await conn.writeFile("app/main.py", 'print("hello from the sandbox")');
await conn.execStream("python3 app/main.py");

// Start a server in the background and open it in a browser.
const processId = await conn.startProcess("python3 -m http.server 8000");
console.log(await conn.previewUrl(8000));
await conn.killProcess(processId);

await conn.dispose();
// docs:end stream
