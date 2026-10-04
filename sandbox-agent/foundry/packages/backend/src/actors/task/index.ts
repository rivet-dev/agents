import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { TaskRecord } from "@sandbox-agent/foundry-shared";
import { taskDb } from "./db/db.js";
import { getCurrentRecord } from "./workflow/common.js";
import {
  changeWorkspaceModel,
  getSessionDetail,
  getTaskDetail,
  getTaskSummary,
  markWorkspaceUnread,
  refreshWorkspaceDerivedState,
  refreshWorkspaceSessionTranscript,
  renameWorkspaceSession,
  renameWorkspaceTask,
  selectWorkspaceSession,
  setWorkspaceSessionUnread,
  syncTaskPullRequest,
  syncWorkspaceSessionStatus,
  updateWorkspaceDraft,
} from "./workspace.js";
import { runTaskWorkflow } from "./workflow/index.js";
import { TASK_QUEUE_NAMES } from "./workflow/queue.js";

export interface TaskInput {
  organizationId: string;
  repoId: string;
  taskId: string;
}

export const task = actor({
  db: taskDb,
  queues: Object.fromEntries(TASK_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Task",
    icon: "wrench",
    actionTimeout: 10 * 60_000,
  },
  createState: (_c, input: TaskInput) => ({
    organizationId: input.organizationId,
    repoId: input.repoId,
    taskId: input.taskId,
  }),
  actions: {
    async get(c): Promise<TaskRecord> {
      return await getCurrentRecord(c);
    },

    async getTaskSummary(c) {
      return await getTaskSummary(c);
    },

    async getTaskDetail(c, input?: { authSessionId?: string }) {
      return await getTaskDetail(c, input?.authSessionId);
    },

    async getSessionDetail(c, input: { sessionId: string; authSessionId?: string }) {
      return await getSessionDetail(c, input.sessionId, input.authSessionId);
    },

    // Direct actions migrated from queue:
    async markUnread(c, input: { authSessionId?: string }) {
      await markWorkspaceUnread(c, input?.authSessionId);
    },
    async renameTask(c, input: { value: string }) {
      await renameWorkspaceTask(c, input.value);
    },
    async renameSession(c, input: { sessionId: string; title: string }) {
      await renameWorkspaceSession(c, input.sessionId, input.title);
    },
    async selectSession(c, input: { sessionId: string; authSessionId?: string }) {
      await selectWorkspaceSession(c, input.sessionId, input?.authSessionId);
    },
    async setSessionUnread(c, input: { sessionId: string; unread: boolean; authSessionId?: string }) {
      await setWorkspaceSessionUnread(c, input.sessionId, input.unread, input?.authSessionId);
    },
    async updateDraft(c, input: { sessionId: string; text: string; attachments: any[]; authSessionId?: string }) {
      await updateWorkspaceDraft(c, input.sessionId, input.text, input.attachments, input?.authSessionId);
    },
    async changeModel(c, input: { sessionId: string; model: string; authSessionId?: string }) {
      await changeWorkspaceModel(c, input.sessionId, input.model, input?.authSessionId);
    },
    async refreshSessionTranscript(c, input: { sessionId: string }) {
      await refreshWorkspaceSessionTranscript(c, input.sessionId);
    },
    async refreshDerived(c) {
      await refreshWorkspaceDerivedState(c);
    },
    async syncSessionStatus(c, input: { sessionId: string; status: "running" | "idle" | "error"; at: number }) {
      await syncWorkspaceSessionStatus(c, input.sessionId, input.status, input.at);
    },
    async syncPullRequest(c, input: { pullRequest: any }) {
      await syncTaskPullRequest(c, input?.pullRequest ?? null);
    },
  },
  run: workflow(runTaskWorkflow),
});

export { taskWorkflowQueueName } from "./workflow/index.js";
