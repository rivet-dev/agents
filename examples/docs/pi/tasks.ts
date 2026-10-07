import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { setup } from "rivetkit";

const PREVIEWS_API = "https://api.example.com/previews";

// A durable task. Each phase saves its checkpoint before the next one starts,
// so after a crash the task carries on from the phase it reached.
const DeployPreview = defineTask<
	{ repo: string; pr: number },
	{ phase: "deploy" } | { phase: "comment"; url: string },
	string
>({
	name: "previews.deploy",
	version: 1,
	initial: () => ({ phase: "deploy" }),
	phases: {
		deploy: async (task, runtime, context) => {
			// The preview id comes from the task id, so a rerun after a crash finds the same preview.
			const response = await fetch(`${PREVIEWS_API}/preview-${task.id}`, {
				method: "PUT",
				body: JSON.stringify(task.input),
			});
			const { url } = (await response.json()) as { url: string };
			await runtime.commit(() => ({ status: "running", checkpoint: { phase: "comment", url } }), context);
		},
		comment: async (task, runtime, context) => {
			const { url } = task.state.checkpoint;
			await fetch(`https://api.github.com/repos/${task.input.repo}/issues/${task.input.pr}/comments`, {
				method: "POST",
				headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
				body: JSON.stringify({ body: `Preview: ${url}` }),
			});
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: url } }), context);
		},
	},
	// Runs when the run is cancelled before the task finishes: delete the preview.
	abort: async (task, runtime, context) => {
		await fetch(`${PREVIEWS_API}/preview-${task.id}`, { method: "DELETE" });
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

const deployPreview = defineTool({
	name: "deploy_preview",
	description: "Deploy a preview of a pull request and post its URL on the pull request.",
	parameters: Type.Object({ repo: Type.String({ description: "owner/name" }), pr: Type.Number() }),
	execute: async (args, api, context) => {
		// Owned by this tool call, so cancelling the run aborts the task too.
		const id = await api.createTask(DeployPreview, args, { ownership: { kind: "task", taskId: api.taskId } }, context);
		const { outcome } = (await api.waitForTask(id, context)).state;
		const text = outcome.status === "completed" ? `Preview at ${outcome.result}.` : `Preview ${outcome.status}.`;
		return { content: [{ type: "text", text }] };
	},
});

const extensions = createRegistry();
extensions.install(defineExtension({ name: "previews", tools: [deployPreview], tasks: [DeployPreview] }));

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	registry: extensions,
});

export const registry = setup({ use: { agent } });

registry.start();
