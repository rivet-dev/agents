import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { getWeather } from "./weather";

// docs:start tools
const extensions = createRegistry();
extensions.install(
	defineExtension({
		name: "personal-assistant",
		tools: [getWeather],
		sections: [
			section(
				"role",
				() => "You are a personal assistant that talks over SMS. Reply in plain text, without Markdown, in a few short sentences.",
			),
		],
	}),
);
// docs:end tools

// One assistant per user, keyed by their phone number.
export const assistant = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	// docs:start answer
	// Texts every answer to the user whose agent this is.
	onAnswer: async (c, answer) => {
		const [phone] = c.key;
		await sendSms(phone, answer.text ?? "Sorry, I couldn't answer that.");
	},
	// docs:end answer
});

async function sendSms(to: string, body: string) {
	const sid = process.env.TWILIO_ACCOUNT_SID;
	const auth = btoa(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`);
	const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
		method: "POST",
		headers: { authorization: `Basic ${auth}` },
		body: new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER ?? "", Body: body }),
	});
	if (!response.ok) throw new Error(`Twilio returned ${response.status}.`);
}
