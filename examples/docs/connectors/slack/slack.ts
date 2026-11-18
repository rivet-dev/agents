import { createHmac, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

export type SlackThread = { eventId: string; channel: string; threadTs: string; text: string };

const web = new WebClient(process.env.SLACK_BOT_TOKEN);
const client = createClient<typeof registry>();

export const slack = new Hono();

slack.post("/events", async (c) => {
	const body = await c.req.text();
	const timestamp = c.req.header("x-slack-request-timestamp") ?? "";
	if (!verifySlackSignature(body, timestamp, c.req.header("x-slack-signature") ?? "")) {
		return c.text("invalid signature", 401);
	}

	const payload = JSON.parse(body);
	if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });
	if (c.req.header("x-slack-retry-num")) return c.body(null, 200);

	const event = payload.event;
	if (payload.type === "event_callback" && event?.type === "app_mention") {
		const threadTs = event.thread_ts ?? event.ts;
		const agent = client.agent.getOrCreate([payload.team_id, event.channel, threadTs]);
		await agent.receive({ eventId: payload.event_id, channel: event.channel, threadTs, text: event.text });
	}
	return c.body(null, 200);
});

export async function postReply(thread: SlackThread, reply: string | undefined) {
	await web.chat.postMessage({
		channel: thread.channel,
		thread_ts: thread.threadTs,
		text: reply || "I finished without a reply.",
	});
}

function verifySlackSignature(body: string, timestamp: string, signature: string): boolean {
	if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
	const secret = process.env.SLACK_SIGNING_SECRET ?? "";
	const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
	return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
