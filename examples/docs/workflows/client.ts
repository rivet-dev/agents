import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>();

// Creating the workflow starts it. The key names this run.
const run = client.flakyTest.getOrCreate(["acme/app", "2026-10-01"]);

let report = await run.getReport();
while (report === null) {
	await new Promise((resolve) => setTimeout(resolve, 60_000));
	report = await run.getReport();
}
console.log(report);
