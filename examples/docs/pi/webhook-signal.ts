import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineSignal, type TaskId } from "@earendil-works/pi-durable";
import { obj, oneOf, str } from "@earendil-works/pi-schema";
import { pi } from "@rivet-dev/pi";
import { Hono } from "hono";
import { setup, UserError } from "rivetkit";
import { createClient } from "rivetkit/client";

// What the CI webhook reports for a build.
const CiResult = defineSignal({ name: "app.ci-result", version: 1, schema: obj({ status: oneOf(["passed", "failed"]) }) });

const BUILDS = "CREATE TABLE IF NOT EXISTS ci_builds (build_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL)";

const agent = pi({
	model: "anthropic/claude-opus-5-5",
	onWake: async (c) => {
		await c.db.execute(BUILDS);
	},
	tools: {
		run_ci: {
			description: "Run CI on a git ref and report the result.",
			parameters: obj({ ref: str() }),
			replay: "safe",
			execute: async (c, args, api, context) => {
				// Once the webhook signals the call, the tool runs again and reads the result.
				const result = await api.readSignal(CiResult, "done", context);
				if (result?.kind === "value") {
					return { output: [{ type: "text", text: `CI ${result.value.status} on ${args.ref}.` }] };
				}
				// Memoized, so a rerun after a crash sends the same buildId again. The CI service must treat a repeated buildId as one build.
				const buildId = await api.memo("ci.build", crypto.randomUUID(), context);
				await c.db.execute("INSERT INTO ci_builds (build_id, task_id) VALUES (?, ?) ON CONFLICT DO NOTHING", buildId, api.taskId);
				await fetch(`${process.env.CI_URL}/builds`, {
					method: "POST",
					body: JSON.stringify({ buildId, ref: args.ref, agentKey: c.key }),
				});
				// The call parks and holds no process, so the agent can sleep until the signal arrives.
				return { kind: "sleep", signals: [CiResult.key("done")] };
			},
		},
	},
	actions: {
		// The webhook handler below calls this action.
		ciFinished: async (c, buildId: string, status: "passed" | "failed") => {
			const [build] = await c.db.execute<{ task_id: number }>("SELECT task_id FROM ci_builds WHERE build_id = ?", buildId);
			if (!build) throw new UserError(`No CI build ${buildId}.`);
			// "delivered", or "duplicate" or "closed" when the webhook is sent again.
			return c.pi.signal(build.task_id as TaskId, CiResult, "done", { status }, BACKGROUND_CONTEXT);
		},
	},
});

export const registry = setup({ use: { agent } });

registry.start();

const client = createClient<typeof registry>();

// Mount this route in your server. Verify the webhook's signature before you trust its body.
export const webhooks = new Hono();

webhooks.post("/ci", async (c) => {
	const { buildId, agentKey, status } = await c.req.json<{ buildId: string; agentKey: string[]; status: "passed" | "failed" }>();
	await client.agent.getOrCreate(agentKey).ciFinished(buildId, status);
	return c.body(null, 202);
});
