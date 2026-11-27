import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { ciAgent } from "./helpers/ci-agent.js";
import { killWithEngine } from "./helpers/kill-with-engine.js";

const CHILD_SCRIPT = fileURLToPath(
	new URL("./helpers/ci-child.ts", import.meta.url),
);

// In its own file: a runner this process started for another test would take
// the child's actor, which then runs without the child's script.
const { registry, answers } = ciAgent({ inChild: false });

type Signaled = {
	conversationId: ConversationId;
	submissionId: SubmissionId;
	delivery: string;
};

/**
 * Runs the agent in its own process against this file's engine data. The
 * process kills itself and its engine the moment the app's signal action
 * replies, so nothing that action started after its commit reaches the engine.
 */
async function signalThenCrash(key: string): Promise<Signaled> {
	const child: ChildProcess = spawn(
		process.execPath,
		["--import", "tsx", CHILD_SCRIPT, key],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr = `${stderr}${chunk}`.slice(-4_000);
	});
	try {
		return await new Promise((resolve, reject) => {
			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
				const signaled = /^SIGNALED (.+)$/m.exec(stdout);
				if (signaled?.[1]) resolve(JSON.parse(signaled[1]));
			});
			child.once("close", (code) =>
				reject(new Error(`the child exited with ${code}: ${stderr}`)),
			);
		});
	} finally {
		if (child.pid !== undefined) await killWithEngine(child.pid);
	}
}

test("a webhook sent again after a crash that cut off the signal action gets duplicate, and the run finishes once with the first value", async (c) => {
	const key = `ci-crash-${randomUUID()}`;
	const { conversationId, submissionId, delivery } = await signalThenCrash(key);
	expect(delivery).toBe("delivered");

	// Start this process's engine and runner on the same data. The webhook
	// sender saw its request fail, so it sends the webhook again.
	const { client } = await setupTest(c, registry);
	const handle = client.agent.getOrCreate([key]);
	expect(await handle.ciFinished("release", "failed")).toBe("duplicate");

	await vi.waitFor(
		() =>
			expect(
				answers.filter(
					(answer) =>
						answer.conversationId === conversationId &&
						answer.text === "CI finished on release",
				),
			).toHaveLength(1),
		{ timeout: 60_000, interval: 250 },
	);
	expect(await handle.submission.wait(submissionId)).toMatchObject({
		status: "done",
	});
	const { messages } = await handle.conversation.context(conversationId);
	expect(
		messages.filter((message) => message.role === "toolResult"),
	).toMatchObject([
		{ isError: false, content: [{ type: "text", text: "CI passed" }] },
	]);
}, 180_000);
