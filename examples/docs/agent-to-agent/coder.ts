import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const requestReview = defineTool({
	name: "request_review",
	description: "Send a finished branch to the repository's reviewer. Don't wait for the review.",
	parameters: Type.Object({ repo: Type.String(), branch: Type.String(), summary: Type.String() }),
	execute: async ({ repo, branch, summary }) => {
		await client.reviewer.getOrCreate([repo]).requestReview(`Review the ${branch} branch of https://github.com/${repo}: ${summary}`);
		return { content: [{ type: "text", text: `Sent ${branch} for review.` }] };
	},
});

const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(defineExtension({ name: "review", tools: [requestReview] }));

export const coder = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
});

const client = createClient<typeof registry>();
