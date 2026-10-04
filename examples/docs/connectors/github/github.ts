import { Octokit } from "@octokit/rest";
import { verify } from "@octokit/webhooks-methods";
import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

export type GitHubComment = { owner: string; repo: string; issueNumber: number; text: string };

const botLogin = process.env.GITHUB_BOT_LOGIN ?? "";
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const client = createClient<typeof registry>();

export const github = new Hono();

github.post("/webhook", async (c) => {
	const body = await c.req.text();
	const signature = c.req.header("x-hub-signature-256") ?? "";
	if (!(await verify(process.env.GITHUB_WEBHOOK_SECRET ?? "", body, signature))) {
		return c.text("invalid signature", 401);
	}
	if (c.req.header("x-github-event") !== "issue_comment") return c.body(null, 202);

	const { action, comment, issue, repository } = JSON.parse(body);
	if (action === "created" && comment.user.login !== botLogin && comment.body.includes(`@${botLogin}`)) {
		const owner = repository.owner.login;
		const agent = client.agent.getOrCreate([owner, repository.name, String(issue.number)]);
		await agent.receive({ owner, repo: repository.name, issueNumber: issue.number, text: comment.body });
	}
	return c.body(null, 202);
});

export async function postReply(comment: GitHubComment, reply: string | undefined) {
	await octokit.rest.issues.createComment({
		owner: comment.owner,
		repo: comment.repo,
		issue_number: comment.issueNumber,
		body: reply || "I finished without a reply.",
	});
}
