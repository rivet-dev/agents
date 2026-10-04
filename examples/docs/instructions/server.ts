import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { pi } from "@rivet-dev/pi";
import { e2bProvider } from "@rivet-dev/sandbox-adapter/e2b";
import { setup } from "rivetkit";

const resourceLoader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	appendSystemPrompt: ["You review pull requests for the payments team. Be brief and cite file paths."],
	agentsFilesOverride: () => ({
		agentsFiles: [
			{ path: "AGENTS.md", content: "Run `npm test` before proposing a fix. Never edit files in `migrations/`." },
		],
	}),
});
await resourceLoader.reload();

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	sandbox: e2bProvider(),
	resourceLoader,
});

export const registry = setup({ use: { agent } });

registry.start();
