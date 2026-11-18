import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// Called from a GitHub webhook. GitHub redelivers a webhook that times out,
// so the delivery id makes a redelivery return the first submission.
export async function onIssueLabeled(repo: string, issue: number, title: string, deliveryId: string) {
	const fixer = client.fixer.getOrCreate([repo, String(issue)]);
	const root = await fixer.harness.root();
	await fixer.conversation.submit(root.id, {
		type: "input",
		content: `Fix issue #${issue} in ${repo}: ${title}. Push a branch and open a pull request.`,
		requestId: deliveryId,
	});
}
