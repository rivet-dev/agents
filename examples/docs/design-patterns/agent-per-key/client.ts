import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

export async function chat(userId: string, message: string) {
	const result = await client.assistant.getOrCreate([userId]).prompt(message);
	return result.status === "done" ? result.text : undefined;
}

export async function onSlackMessage(channel: string, threadTs: string, text: string) {
	const result = await client.slackThread.getOrCreate([channel, threadTs]).prompt(text);
	return result.status === "done" ? result.text : undefined;
}

export async function onIssueLabeled(repo: string, issue: { number: number; title: string; body: string }) {
	const fixer = client.issueFixer.getOrCreate([repo, String(issue.number)]);
	try {
		const result = await fixer.prompt(
			`Clone https://github.com/${repo}, fix issue #${issue.number}, and open a pull request.\n\n# ${issue.title}\n\n${issue.body}`,
		);
		return result.status === "done" ? result.text : undefined;
	} finally {
		await fixer.finish();
	}
}
