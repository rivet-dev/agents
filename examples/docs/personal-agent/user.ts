import { actor } from "rivetkit";
import { db } from "rivetkit/db";

// One user per phone number. The key is the number in E.164 format, such as +15551234567.
export const user = actor({
	// docs:start schema
	db: db({
		onMigrate: async (db) => {
			await db.execute(`
				CREATE TABLE IF NOT EXISTS profile (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					verified_at INTEGER NOT NULL
				)
			`);
		},
	}),
	// docs:end schema
	actions: {
		// docs:start sign-in
		// Step 1: text the user a code. Twilio Verify creates, expires, and rate limits it.
		sendCode: async (c) => {
			const [phone] = c.key;
			await twilioVerify("Verifications", { To: phone, Channel: "sms" });
		},
		// Step 2: check the code and remember the sign-in.
		verify: async (c, code: string) => {
			const [phone] = c.key;
			const check = await twilioVerify("VerificationCheck", { To: phone, Code: code });
			if (check?.status !== "approved") return false;
			await c.db.execute(
				"INSERT INTO profile (id, verified_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET verified_at = excluded.verified_at",
				Date.now(),
			);
			return true;
		},
		// docs:end sign-in
		// docs:start signed-in
		isSignedIn: async (c): Promise<boolean> => {
			const rows = await c.db.execute("SELECT verified_at FROM profile");
			return rows.length > 0;
		},
		// docs:end signed-in
	},
});

async function twilioVerify(path: string, params: Record<string, string>) {
	const service = process.env.TWILIO_VERIFY_SERVICE_SID;
	const auth = btoa(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`);
	const response = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
		method: "POST",
		headers: { authorization: `Basic ${auth}` },
		body: new URLSearchParams(params),
	});
	// Verify answers 404 when there's no pending code for the number, such as after it expired.
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`Twilio Verify returned ${response.status}.`);
	return (await response.json()) as { status: string };
}
