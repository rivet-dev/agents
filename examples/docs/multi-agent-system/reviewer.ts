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
	// docs:start review
	// The reviewer's own table, in its database next to Pi Durable's.
	onWake: async (c) => {
		await c.db.execute("CREATE TABLE IF NOT EXISTS review (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT)");
	},
	// Saves each review so your app can read it.
	onAnswer: async (c, answer) => {
		await c.db.execute("INSERT OR REPLACE INTO review (id, text) VALUES (1, ?)", answer.text ?? null);
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
		getReview: async (c) => {
			const [review] = await c.db.execute<{ text: string | null }>("SELECT text FROM review WHERE id = 1");
			return review?.text ?? null;
		},
	},
	// docs:end review
});
