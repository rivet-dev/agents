import { createHmac, timingSafeEqual } from "node:crypto";
import { LinearClient } from "@linear/sdk";
import { Hono } from "hono";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

export type LinearComment = { issueId: string; text: string };

const trigger = process.env.LINEAR_TRIGGER ?? "@agent";
const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
const agentUserId = linear.viewer.then((viewer) => viewer.id);
const client = createClient<typeof registry>();

export const linearRoutes = new Hono();

linearRoutes.post("/webhook", async (c) => {
	const body = await c.req.text();
	if (!verifyLinearSignature(body, c.req.header("linear-signature") ?? "")) {
		return c.text("invalid signature", 401);
	}

	const payload = JSON.parse(body);
	if (Math.abs(Date.now() - payload.webhookTimestamp) > 60 * 1000) return c.text("stale webhook", 401);

	const comment = payload.data;
	if (
		payload.type === "Comment" &&
		payload.action === "create" &&
		comment.issueId &&
		comment.body.includes(trigger) &&
		comment.userId !== (await agentUserId)
	) {
		const agent = client.agent.getOrCreate(["linear", comment.issueId]);
		await agent.receive({ issueId: comment.issueId, text: comment.body });
	}
	return c.body(null, 200);
});

export async function postReply(comment: LinearComment, reply: string | undefined) {
	await linear.createComment({ issueId: comment.issueId, body: reply || "I finished without a reply." });
}

function verifyLinearSignature(body: string, signature: string): boolean {
	const secret = process.env.LINEAR_WEBHOOK_SECRET ?? "";
	const expected = createHmac("sha256", secret).update(body).digest("hex");
	return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
