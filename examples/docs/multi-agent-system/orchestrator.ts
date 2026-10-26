import { Type } from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	ROOT_CONVERSATION_ID,
	section,
} from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

// docs:start fan-out
const askSpecialist = defineTool({
	name: "ask_specialist",
	description: "Give each subtask to its own researcher. They work in parallel, and you get every answer back.",
	parameters: Type.Object({
		subtasks: Type.Array(
			Type.String({ description: "One self-contained question. The researcher can't see this conversation." }),
			{ minItems: 1, maxItems: 8 },
		),
	}),
	// A rerun after a crash reaches the same researchers, through the memo below.
	replay: "safe",
	execute: async ({ subtasks }, api, context) => {
		// One id per subtask, saved with this tool call, so a rerun gets the same ids.
		const ids = await api.memo("researcher-ids", subtasks.map(() => crypto.randomUUID()), context);

		const answers = await Promise.all(
			ids.map(async (id, i) => {
				const researcher = client.researcher.getOrCreate([id]);
				context.abortSignal?.addEventListener("abort", () => void researcher.conversation.abort(ROOT_CONVERSATION_ID));
				// A researcher that already answered returns its saved answer for the same requestId.
				const result = await researcher.prompt(subtasks[i], { requestId: id });
				if (result.status === "unanswered") return `No answer: ${result.reason}`;
				return result.text || "The researcher finished without an answer.";
			}),
		);

		const text = subtasks.map((subtask, i) => `## ${subtask}\n\n${answers[i]}`).join("\n\n");
		return { content: [{ type: "text", text }] };
	},
});
// docs:end fan-out

// docs:start agent
const extensions = createRegistry();
extensions.install(
	defineExtension({
		name: "orchestrator",
		tools: [askSpecialist],
		sections: [
			section(
				"role",
				() =>
					"You run research jobs. Split the job into independent subtasks, send them all to ask_specialist in one call, and combine the answers into one report.",
			),
		],
	}),
);

// One orchestrator per job, keyed by the job id.
export const orchestrator = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	// Hands every finished report to the job's reviewer without waiting for the review.
	onAnswer: async (c, answer) => {
		const [jobId] = c.key;
		if (!answer.text) return;
		// The answer's timestamp is saved with it, so a repeated call sends the same requestId.
		await client.reviewer.getOrCreate([jobId]).requestReview(answer.text, `${jobId}:${answer.message.timestamp}`);
	},
});
// docs:end agent

const client = createClient<typeof registry>();
