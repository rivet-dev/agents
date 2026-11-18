import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// docs:start start
// Each job gets its own orchestrator, keyed by the job id.
const jobId = crypto.randomUUID();
const orchestrator = client.orchestrator.getOrCreate([jobId]);

// Starts the job and returns without waiting for it.
// The job id is also the requestId, so a retried call doesn't start the job twice.
await orchestrator.submit("Compare SQLite, Postgres, and DuckDB for an analytics dashboard with 50 million rows.", {
	requestId: jobId,
});
console.log(`Started job ${jobId}`);
// docs:end start

// docs:start review
// Check the job's reviewer every 30 seconds until the review is in.
const reviewer = client.reviewer.getOrCreate([jobId]);
let review = await reviewer.getReview();
while (review === null) {
	await new Promise((resolve) => setTimeout(resolve, 30_000));
	review = await reviewer.getReview();
}
console.log(review);
// docs:end review
