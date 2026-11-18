import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { Hono } from "hono";
import { setup } from "rivetkit";
import { postReply, slack, type SlackThread } from "./slack";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: createRegistry(),
	actions: {
		// Schedules the answer and returns, so the route can respond in time.
		receive: async (c, thread: SlackThread) => {
			await c.schedule.after(0, "reply", thread);
		},
		reply: async (c, thread: SlackThread): Promise<void> => {
			const self = c.client<typeof registry>().agent.getForId(c.actorId);
			// A message sent during a run waits as a follow-up.
			// The requestId stops a duplicate delivery from running twice.
			const result = await self.prompt(thread.text, { requestId: thread.eventId });
			await postReply(thread, result.status === "done" ? result.text : undefined);
		},
	},
});

export const registry = setup({ use: { agent } });

const app = new Hono();
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));
app.route("/slack", slack);

export default app;
