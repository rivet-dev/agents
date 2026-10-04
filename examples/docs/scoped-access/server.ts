import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";
import { admin, report } from "./report";

const shareReport = defineTool({
	name: "share_report",
	label: "Share report",
	description: "Publish a report and return a link anyone can open for the next hour.",
	parameters: Type.Object({ title: Type.String(), body: Type.String() }),
	async execute(_toolCallId, { title, body }) {
		const handle = await admin.report.create([crypto.randomUUID()], { input: { title, body } });
		const { token } = await handle.issueToken({ subject: "shared-report", expiresIn: 3600 });
		const url = `https://app.example.com/reports/${await handle.resolve()}#${token}`;
		return { content: [{ type: "text", text: `Shared at ${url}` }], details: { url } };
	},
});

const agent = pi({ model: "anthropic/claude-opus-5-5", customTools: [shareReport] });

export const registry = setup({ use: { agent, report } });

registry.start();
