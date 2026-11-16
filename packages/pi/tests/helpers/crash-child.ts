// Starts a run on the crash agent and prints its conversation and submission
// once the tool is running, then hangs until tests/crash-recovery.test.ts
// kills this process with its engine.
import { setupTest } from "rivetkit/test";
import { crashAgent } from "./crash-agent.js";

const { registry } = crashAgent({ inChild: true });
const { client } = await setupTest(
	{ onTestFinished() {} } as unknown as Parameters<typeof setupTest>[0],
	registry,
);
const handle = client.agent.getOrCreate([process.argv[2] ?? "crash"]);
const root = await handle.harness.root();
const submission = await handle.conversation.submit(root.id, {
	type: "input",
	content: "run the tool",
});
process.stdout.write(
	`STARTED ${JSON.stringify({ conversationId: root.id, submissionId: submission.id })}\n`,
);
await new Promise(() => {});
