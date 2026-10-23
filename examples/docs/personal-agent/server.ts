import { createHmac, timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { assistant } from "./assistant";
import { user } from "./user";

export const registry = setup({ use: { user, assistant } });
const client = createClient<typeof registry>();

registry.start();

const app = new Hono();

// docs:start webhook
// Twilio calls this for every text to your number.
app.post("/sms/webhook", async (c) => {
	const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
	if (!verifyTwilioSignature(params, c.req.header("x-twilio-signature") ?? "")) {
		return c.text("invalid signature", 401);
	}

	// Ask the sender's user Actor whether they signed in.
	const phone = params.From;
	if (!(await client.user.getOrCreate([phone]).isSignedIn())) {
		return twiml("<Message>Sign in with this number to talk to your assistant.</Message>");
	}

	// Hand the text to the sender's assistant without waiting for the answer. Their first text creates it.
	// The message id stops a duplicate delivery from running the agent twice.
	await client.assistant.getOrCreate([phone]).submit(params.Body, { requestId: params.MessageSid });
	// An empty response sends nothing. The assistant texts its answer from onAnswer.
	return twiml("");
});
// docs:end webhook

serve({ fetch: app.fetch, port: 3000 });

// Twilio signs the webhook URL followed by each POST parameter's name and value, sorted by name.
function verifyTwilioSignature(params: Record<string, string>, signature: string): boolean {
	const url = process.env.TWILIO_WEBHOOK_URL ?? "";
	const payload = url + Object.keys(params).sort().map((key) => key + params[key]).join("");
	const expected = createHmac("sha1", process.env.TWILIO_AUTH_TOKEN ?? "").update(payload).digest("base64");
	return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function twiml(message: string) {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${message}</Response>`, {
		headers: { "content-type": "text/xml" },
	});
}
