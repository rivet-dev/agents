import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const reportId = location.pathname.split("/").pop() ?? "";
const token = location.hash.slice(1);

const client = createClient<typeof registry>({
	endpoint: "https://api.rivet.dev",
	namespace: "production",
	token,
});

const report = await client.report.getForId(reportId).read();
document.title = report.title;
document.body.textContent = report.body;
