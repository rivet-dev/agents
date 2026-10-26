import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { bookFlight, searchFlights } from "./tools";

// docs:start plan
// The agent's plan, saved with the conversation in the agent's SQLite database.
export const Plan = defineDoc<{ steps: { text: string; done: boolean }[] }>({
	kind: "travel.plan",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ steps: [] }),
});

const updatePlan = defineTool({
	name: "update_plan",
	description: "Save your plan for a request that takes more than one step. Call it again whenever a step is done.",
	parameters: Type.Object({
		steps: Type.Array(Type.Object({ text: Type.String(), done: Type.Boolean() })),
	}),
	// Saving the same plan twice is harmless.
	replay: "safe",
	execute: async ({ steps }, api, context) => {
		await api.commit(async (tx) => {
			(await tx.doc(Plan, api.conversationId)).steps = steps;
		}, context);
		return { content: [{ type: "text", text: "Plan saved." }] };
	},
});

// Shows the plan to the model before every model call, even after older messages are compacted.
const planSection = section("plan", async (input, context) => {
	const plan = await input.read.snapshot(Plan, input.conversationId, context);
	if (!plan?.steps.length) return undefined;
	return plan.steps.map((step) => `- [${step.done ? "x" : " "}] ${step.text}`).join("\n");
});
// docs:end plan

// docs:start agent
const extensions = createRegistry();
extensions.install(
	defineExtension({
		name: "travel",
		tools: [updatePlan, searchFlights, bookFlight],
		sections: [
			section("role", () => "You are a travel assistant. Ask the user to confirm before you book anything."),
			planSection,
		],
	}),
);

// One agent per conversation, keyed by the conversation id.
export const chatAgent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	// Lets clients read the plan with harness.snapshot.
	documents: [Plan],
});
// docs:end agent
