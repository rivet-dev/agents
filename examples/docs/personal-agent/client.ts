import { createInterface } from "node:readline/promises";
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const input = createInterface({ input: process.stdin, output: process.stdout });

// 1. Enter your number and send a code.
const phone = await input.question("Phone number, such as +15551234567: ");
const user = client.user.getOrCreate([phone]);
await user.sendCode();

// 2. Enter the code you got.
const code = await input.question("Code: ");
if (await user.verify(code)) {
	console.log(`Signed in. Text ${process.env.TWILIO_PHONE_NUMBER} to talk to your assistant.`);
} else {
	console.log("That code is wrong or expired.");
}
input.close();
