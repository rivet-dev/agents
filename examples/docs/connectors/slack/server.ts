import { pi } from "@rivet-dev/pi";
import { Hono } from "hono";
import { setup } from "rivetkit";
import { postReply, slack, type SlackThread } from "./slack";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	state: { pending: [] as SlackThread[] },
	vars: { replying: false },
	actions: {
		receive: async (c, thread: SlackThread) => {
			c.state.pending.push(thread);
			await c.schedule.after(0, "drain");
		},
		// Answers the oldest message. Messages that arrive mid-run wait their turn.
		drain: async (c): Promise<void> => {
			const thread = c.state.pending[0];
			if (!thread || c.vars.replying) return;
			c.vars.replying = true;
			try {
				const self = c.client<typeof registry>().agent.getForId(c.actorId);
				await self.prompt(thread.text);
				await postReply(thread, await self.getLastAssistantText());
			} catch (error) {
				c.log.error({ msg: "reply failed", error });
			} finally {
				c.state.pending.shift();
				c.vars.replying = false;
			}
			if (c.state.pending.length > 0) await c.schedule.after(0, "drain");
		},
	},
});

export const registry = setup({ use: { agent } });

const app = new Hono();
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));
app.route("/slack", slack);

export default app;
