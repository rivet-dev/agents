import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";

const extensions = createRegistry();
extensions.install(
	defineExtension({
		name: "review",
		sections: [
			section(
				"role",
				() =>
					"You review research reports. List claims without a source, gaps, and contradictions, then end with APPROVE or REVISE.",
			),
		],
	}),
);

// One reviewer per job, keyed by the job id.
export const reviewer = pi({
	model: "openai/gpt-5.5",
	registry: extensions,
	state: { review: null as string | null },
	// docs:start review
	// Saves each review so your app can read it.
	onAnswer: (c, answer) => {
		c.state.review = answer.text ?? null;
	},
	actions: {
		// Saves the request and returns without waiting for the review.
		requestReview: async (c, report: string, requestId: string) => {
			const conversation = await c.pi.root(BACKGROUND_CONTEXT);
			await conversation.submit(
				{ type: "input", content: `Review this report:\n\n${report}`, requestId },
				BACKGROUND_CONTEXT,
			);
		},
		getReview: (c) => c.state.review,
	},
	// docs:end review
});
