import { randomUUID } from "node:crypto";
import { setupTest } from "rivetkit/test";
import { expect, test, vi } from "vitest";
import { ciAgent } from "./helpers/ci-agent.js";
import { createSleepCounter } from "./helpers/sleeps.js";

const sleeps = createSleepCounter();
const { registry, answers } = ciAgent({
	inChild: false,
	onSleep: sleeps.record,
});

test("a tool parked on a signal lets the actor sleep, and an app action that signals it wakes the actor and finishes the run with no other call", async (c) => {
	const { client } = await setupTest(c, registry);
	const key = [`ci-${randomUUID()}`];
	const handle = client.agent.getOrCreate(key);
	const root = await handle.harness.root();
	const submission = await handle.conversation.submit(root.id, {
		type: "input",
		content: "wait for CI on main",
	});
	await sleeps.waitFor(key, 1);

	expect(await handle.ciFinished("main", "passed")).toBe("delivered");

	// Call nothing else: any other call would wake the actor and resume the run.
	await vi.waitFor(
		() =>
			expect(
				answers.filter(
					(answer) =>
						answer.conversationId === root.id &&
						answer.text === "CI finished on main",
				),
			).toHaveLength(1),
		{ timeout: 20_000, interval: 100 },
	);
	expect(await handle.submission.wait(submission.id)).toMatchObject({
		status: "done",
	});
	const { messages } = await handle.conversation.context(root.id);
	expect(
		messages.filter((message) => message.role === "toolResult"),
	).toMatchObject([
		{ isError: false, content: [{ type: "text", text: "CI passed" }] },
	]);
	// A webhook that delivers again gets a final answer and runs nothing.
	expect(await handle.ciFinished("main", "failed")).toBe("closed");
});
