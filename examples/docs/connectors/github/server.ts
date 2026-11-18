import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { Hono } from "hono";
import { setup } from "rivetkit";
import { type GitHubComment, github, postReply } from "./github";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	actions: {
		// Schedules the answer and returns, so the route can respond in time.
		receive: async (c, comment: GitHubComment) => {
			await c.schedule.after(0, "reply", comment);
		},
		reply: async (c, comment: GitHubComment): Promise<void> => {
			const self = c.client<typeof registry>().agent.getForId(c.actorId);
			// A message sent during a run waits as a follow-up.
			// The requestId stops a duplicate delivery from running twice.
			const result = await self.prompt(comment.text, { requestId: comment.commentId });
			await postReply(comment, result.status === "done" ? result.text : undefined);
		},
	},
});

export const registry = setup({ use: { agent } });

const app = new Hono();
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));
app.route("/github", github);

export default app;
