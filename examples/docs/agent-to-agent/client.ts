import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();
const coder = client.coder.getOrCreate(["acme/app", "fix-flaky-checkout-test"]);

const result = await coder.prompt(
	"Clone https://github.com/acme/app, fix the flaky checkout test on a new fix-flaky-checkout-test branch, push it, and request a review.",
);
console.log(result.status === "done" ? result.text : `Unanswered: ${result.reason}`);
