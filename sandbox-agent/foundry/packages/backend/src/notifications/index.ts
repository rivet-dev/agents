import type { NotifyBackend, NotifyUrgency } from "./backends.js";

export type { NotifyUrgency } from "./backends.js";
export { createBackends } from "./backends.js";

export interface NotificationService {
  notify(title: string, body: string, urgency: NotifyUrgency): Promise<void>;
  agentIdle(branchName: string): Promise<void>;
  agentError(branchName: string, error: string): Promise<void>;
  ciPassed(branchName: string, prNumber: number): Promise<void>;
  ciFailed(branchName: string, prNumber: number): Promise<void>;
  prApproved(branchName: string, prNumber: number, reviewer: string): Promise<void>;
  changesRequested(branchName: string, prNumber: number, reviewer: string): Promise<void>;
  prMerged(branchName: string, prNumber: number): Promise<void>;
  taskCreated(branchName: string): Promise<void>;
}

export function createNotificationService(backends: NotifyBackend[]): NotificationService {
  async function notify(title: string, body: string, urgency: NotifyUrgency): Promise<void> {
    for (const backend of backends) {
      const sent = await backend.send(title, body, urgency);
      if (sent) {
        return;
      }
    }
  }

  return {
    notify,

    async agentIdle(branchName: string): Promise<void> {
      await notify("Agent Idle", `Agent finished on ${branchName}`, "normal");
    },

    async agentError(branchName: string, error: string): Promise<void> {
      await notify("Agent Error", `Agent error on ${branchName}: ${error}`, "high");
    },

    async ciPassed(branchName: string, prNumber: number): Promise<void> {
      await notify("CI Passed", `CI passed on ${branchName} (PR #${prNumber})`, "low");
    },

    async ciFailed(branchName: string, prNumber: number): Promise<void> {
      await notify("CI Failed", `CI failed on ${branchName} (PR #${prNumber})`, "high");
    },

    async prApproved(branchName: string, prNumber: number, reviewer: string): Promise<void> {
      await notify("PR Approved", `PR #${prNumber} on ${branchName} approved by ${reviewer}`, "normal");
    },

    async changesRequested(branchName: string, prNumber: number, reviewer: string): Promise<void> {
      await notify("Changes Requested", `Changes requested on PR #${prNumber} (${branchName}) by ${reviewer}`, "high");
    },

    async prMerged(branchName: string, prNumber: number): Promise<void> {
      await notify("PR Merged", `PR #${prNumber} on ${branchName} merged`, "normal");
    },

    async taskCreated(branchName: string): Promise<void> {
      await notify("Task Created", `New task on ${branchName}`, "low");
    },
  };
}
