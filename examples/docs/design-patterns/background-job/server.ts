import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { piDurable } from "@rivet-dev/pi/durable";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const openPullRequest = defineTool({
	name: "open_pull_request",
	description: "Open a pull request from a pushed branch.",
	parameters: Type.Object({ repo: Type.String(), branch: Type.String(), title: Type.String() }),
	// No replay: if a crash cuts this call off, the model learns it never completed
	// and can check for an existing pull request before opening another.
	execute: async ({ repo, branch, title }) => {
		const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
			method: "POST",
			headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" },
			body: JSON.stringify({ head: branch, base: "main", title }),
		});
		if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
		const pull = (await response.json()) as { html_url: string };
		return { content: [{ type: "text", text: pull.html_url }] };
	},
});

const extensions = createRegistry();
extensions.install(CodingTools);
extensions.install(defineExtension({ name: "github", tools: [openPullRequest] }));

const fixer = piDurable({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
	sandbox: e2bProvider(),
});

export const registry = setup({ use: { fixer } });

registry.start();
