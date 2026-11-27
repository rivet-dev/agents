// Parks a CI tool and signals it through the app's action. As soon as the
// action replies, prints its ids and kills this process and its engine, so
// work the reply did not wait for never lands.
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { setupTest } from "rivetkit/test";
import { ciAgent } from "./ci-agent.js";

const { registry } = ciAgent({ inChild: true });
const { client } = await setupTest(
	{ onTestFinished() {} } as unknown as Parameters<typeof setupTest>[0],
	registry,
);
const handle = client.agent.getOrCreate([process.argv[2] ?? "ci"]);
const root = await handle.harness.root();
const submission = await handle.conversation.submit(root.id, {
	type: "input",
	content: "wait for CI on release",
});
for (;;) {
	const { tasks } = await handle.harness.inspect();
	if (tasks.some((task) => task.state.kind === "sleeping")) break;
	await new Promise((resolve) => setTimeout(resolve, 100));
}
const engines = spawnSync("pgrep", ["-P", String(process.pid)], {
	encoding: "utf8",
})
	.stdout.split("\n")
	.filter(Boolean)
	.map(Number);
const delivery = await handle.ciFinished("release", "passed");
writeSync(
	1,
	`SIGNALED ${JSON.stringify({ conversationId: root.id, submissionId: submission.id, delivery })}\n`,
);
for (const pid of engines) process.kill(pid, "SIGKILL");
process.kill(process.pid, "SIGKILL");
