import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

export async function chat(userId: string, message: string) {
	const assistant = client.assistant.getOrCreate([userId]);
	await assistant.prompt(message);
	return assistant.getLastAssistantText();
}

export async function onSlackMessage(channel: string, threadTs: string, text: string) {
	const thread = client.slackThread.getOrCreate([channel, threadTs]);
	await thread.prompt(text);
	return thread.getLastAssistantText();
}

export async function onIssueLabeled(repo: string, issue: { number: number; title: string; body: string }) {
	const fixer = client.issueFixer.getOrCreate([repo, String(issue.number)]);
	try {
		await fixer.prompt(
			`Clone https://github.com/${repo}, fix issue #${issue.number}, and open a pull request.\n\n# ${issue.title}\n\n${issue.body}`,
		);
		return await fixer.getLastAssistantText();
	} finally {
		await fixer.finish();
	}
}
