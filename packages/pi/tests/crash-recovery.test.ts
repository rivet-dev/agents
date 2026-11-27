import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { crashAgent } from "./helpers/crash-agent.js";
import { killWithEngine } from "./helpers/kill-with-engine.js";

const CHILD_SCRIPT = fileURLToPath(
	new URL("./helpers/crash-child.ts", import.meta.url),
);

const { registry, events, answers } = crashAgent({ inChild: false });

type Started = { conversationId: ConversationId; submissionId: SubmissionId };

/**
 * Runs the agent in its own process against this file's engine data, and
 * kills that process and its engine once the run's tool is running.
 */
async function startThenCrash(key: string): Promise<Started> {
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
				const started = /^STARTED (.+)$/m.exec(stdout);
				if (started?.[1] && /^TOOL_RUNNING$/m.test(stdout)) {
					// Leave time for the recovery wake the active run scheduled to be written.
					setTimeout(() => resolve(JSON.parse(started[1] as string)), 1_000);
				}
			});
			child.once("exit", (code) =>
				reject(new Error(`the child exited with ${code}: ${stderr}`)),
			);
		});
	} finally {
		if (child.pid !== undefined) await killWithEngine(child.pid);
	}
}

test("an actor killed during a run resumes it by itself with no call, then stays asleep", async (c) => {
	const key = `crash-${randomUUID()}`;
	const { conversationId, submissionId } = await startThenCrash(key);

	// Start this process's engine and runner on the same data, and call nothing.
	const { client } = await setupTest(c, registry);
	await vi.waitFor(
		() => {
			expect(events).toEqual(["wake", "tool", "answer", "sleep"]);
			expect(answers.map((answer) => answer.text)).toEqual([
				"the tool finished",
			]);
		},
		{ timeout: 90_000, interval: 250 },
	);
	// Longer than the recovery wake runs ahead of active work: a wake left
	// scheduled after the run would wake the idle actor in this time.
	await new Promise((resolve) => setTimeout(resolve, 20_000));
	expect(events).toEqual(["wake", "tool", "answer", "sleep"]);

	const handle = client.agent.getOrCreate([key]);
	expect(await handle.submission.wait(submissionId)).toMatchObject({
		status: "done",
	});
	const { messages } = await handle.conversation.context(conversationId);
	expect(
		messages.find((message) => message.role === "toolResult"),
	).toMatchObject({
		isError: false,
		content: [{ type: "text", text: "tool output" }],
	});
}, 180_000);
