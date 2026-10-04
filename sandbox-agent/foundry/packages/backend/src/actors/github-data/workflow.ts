// @ts-nocheck
import { logActorWarning, resolveErrorMessage } from "../logging.js";

// Dynamic imports to break circular dependency: index.ts imports workflow.ts,
// and workflow.ts needs functions from index.ts.
async function getIndexModule() {
  return await import("./index.js");
}

export const GITHUB_DATA_QUEUE_NAMES = [
  "githubData.command.syncRepos",
  "githubData.command.handlePullRequestWebhook",
  "githubData.command.clearState",
] as const;

export type GithubDataQueueName = (typeof GITHUB_DATA_QUEUE_NAMES)[number];

export function githubDataWorkflowQueueName(name: GithubDataQueueName): GithubDataQueueName {
  return name;
}

/**
 * Plain run handler (no workflow engine). Drains the queue using `c.queue.iter()`
 * with completable messages. This avoids the RivetKit bug where actors created
 * from another actor's workflow context never start their `run: workflow(...)`.
 */
export async function runGithubDataCommandLoop(c: any): Promise<void> {
  for await (const msg of c.queue.iter({ names: [...GITHUB_DATA_QUEUE_NAMES], completable: true })) {
    try {
      if (msg.name === "githubData.command.syncRepos") {
        try {
          const { runFullSync } = await getIndexModule();
          await runFullSync(c, msg.body);
          await msg.complete({ ok: true });
        } catch (error) {
          const { fullSyncError } = await getIndexModule();
          try {
            await fullSyncError(c, error);
          } catch {
            /* best effort */
          }
          const message = error instanceof Error ? error.message : String(error);
          await msg.complete({ error: message }).catch(() => {});
        }
        continue;
      }

      if (msg.name === "githubData.command.handlePullRequestWebhook") {
        const { handlePullRequestWebhookMutation } = await getIndexModule();
        await handlePullRequestWebhookMutation(c, msg.body);
        await msg.complete({ ok: true });
        continue;
      }

      if (msg.name === "githubData.command.clearState") {
        const { clearStateMutation } = await getIndexModule();
        await clearStateMutation(c, msg.body);
        await msg.complete({ ok: true });
        continue;
      }

      logActorWarning("githubData", "unknown queue message", { queueName: msg.name });
      await msg.complete({ error: `Unknown command: ${msg.name}` });
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("githubData", "github-data command failed", {
        queueName: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }
  }
}
