// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import type {
  AuditLogEvent,
  CreateTaskInput,
  HistoryQueryInput,
  ListTasksInput,
  RepoOverview,
  SwitchResult,
  TaskRecord,
  TaskSummary,
  TaskWorkspaceChangeModelInput,
  TaskWorkspaceChangeOwnerInput,
  TaskWorkspaceCreateTaskInput,
  TaskWorkspaceDiffInput,
  TaskWorkspaceRenameInput,
  TaskWorkspaceRenameSessionInput,
  TaskWorkspaceSelectInput,
  TaskWorkspaceSetSessionUnreadInput,
  TaskWorkspaceSendMessageInput,
  TaskWorkspaceSessionInput,
  TaskWorkspaceUpdateDraftInput,
} from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../../context.js";
import { getOrCreateAuditLog, getOrCreateTask, getTask as getTaskHandle } from "../../handles.js";
import { defaultSandboxProviderId } from "../../../sandbox-config.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { taskWorkflowQueueName } from "../../task/workflow/queue.js";
import { expectQueueResponse } from "../../../services/queue.js";
import { taskIndex, taskSummaries } from "../db/schema.js";
import {
  createTaskMutation,
  getRepoOverviewFromOrg,
  getRepositoryMetadataFromOrg,
  findTaskForBranch,
  listTaskSummariesForRepo,
  listAllTaskSummaries,
} from "./task-mutations.js";

function assertOrganization(c: { state: { organizationId: string } }, organizationId: string): void {
  if (organizationId !== c.state.organizationId) {
    throw new Error(`Organization actor mismatch: actor=${c.state.organizationId} command=${organizationId}`);
  }
}

/**
 * Look up the repoId for a task from the local task index.
 * Used when callers (e.g. sandbox actor) only have taskId but need repoId
 * to construct the task actor key.
 */
async function resolveTaskRepoId(c: any, taskId: string): Promise<string> {
  const row = await c.db.select({ repoId: taskIndex.repoId }).from(taskIndex).where(eq(taskIndex.taskId, taskId)).get();
  if (!row) {
    throw new Error(`Task ${taskId} not found in task index`);
  }
  return row.repoId;
}

/**
 * Get or lazily create a task actor for a user-initiated action.
 * Uses getOrCreate because the user may be interacting with a virtual task
 * (PR-driven) that has no actor yet. The task actor self-initializes in
 * getCurrentRecord() from the org's getTaskIndexEntry data.
 *
 * This is safe because requireWorkspaceTask is only called from user-initiated
 * actions (createSession, sendMessage, etc.), never from sync loops.
 * See CLAUDE.md "Lazy Task Actor Creation".
 */
async function requireWorkspaceTask(c: any, repoId: string, taskId: string) {
  return getOrCreateTask(c, c.state.organizationId, repoId, taskId, {
    organizationId: c.state.organizationId,
    repoId,
    taskId,
  });
}

interface GetTaskInput {
  organizationId: string;
  repoId: string;
  taskId: string;
}

interface TaskProxyActionInput extends GetTaskInput {
  reason?: string;
}

interface RepoOverviewInput {
  organizationId: string;
  repoId: string;
}

export { createTaskMutation };

export const organizationTaskActions = {
  async createTask(c: any, input: CreateTaskInput): Promise<TaskRecord> {
    assertOrganization(c, input.organizationId);
    const { config } = getActorRuntimeContext();
    const sandboxProviderId = input.sandboxProviderId ?? defaultSandboxProviderId(config);

    // Self-call: call the mutation directly since we're inside the org actor
    return await createTaskMutation(c, {
      repoId: input.repoId,
      task: input.task,
      sandboxProviderId,
      explicitTitle: input.explicitTitle ?? null,
      explicitBranchName: input.explicitBranchName ?? null,
      onBranch: input.onBranch ?? null,
    });
  },

  async materializeTask(c: any, input: { organizationId: string; repoId: string; virtualTaskId: string }): Promise<TaskRecord> {
    assertOrganization(c, input.organizationId);
    const { config } = getActorRuntimeContext();
    // Self-call: call the mutation directly
    return await createTaskMutation(c, {
      repoId: input.repoId,
      task: input.virtualTaskId,
      sandboxProviderId: defaultSandboxProviderId(config),
      explicitTitle: null,
      explicitBranchName: null,
      onBranch: null,
    });
  },

  async createWorkspaceTask(c: any, input: TaskWorkspaceCreateTaskInput): Promise<{ taskId: string; sessionId?: string }> {
    const created = await organizationTaskActions.createTask(c, {
      organizationId: c.state.organizationId,
      repoId: input.repoId,
      task: input.task,
      ...(input.title ? { explicitTitle: input.title } : {}),
      ...(input.onBranch ? { onBranch: input.onBranch } : input.branch ? { explicitBranchName: input.branch } : {}),
    });

    const task = await requireWorkspaceTask(c, input.repoId, created.taskId);
    void task
      .send(
        taskWorkflowQueueName("task.command.workspace.create_session_and_send"),
        {
          model: input.model,
          text: input.task,
          authSessionId: input.authSessionId,
        },
        { wait: false },
      )
      .catch(() => {});

    return { taskId: created.taskId };
  },

  async markWorkspaceUnread(c: any, input: TaskWorkspaceSelectInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.markUnread({ authSessionId: input.authSessionId });
  },

  async renameWorkspaceTask(c: any, input: TaskWorkspaceRenameInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.renameTask({ value: input.value });
  },

  async createWorkspaceSession(c: any, input: TaskWorkspaceSelectInput & { model?: string }): Promise<{ sessionId: string }> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    return expectQueueResponse(
      await task.send(
        taskWorkflowQueueName("task.command.workspace.create_session"),
        {
          ...(input.model ? { model: input.model } : {}),
          ...(input.authSessionId ? { authSessionId: input.authSessionId } : {}),
        },
        { wait: true, timeout: 10_000 },
      ),
    );
  },

  async renameWorkspaceSession(c: any, input: TaskWorkspaceRenameSessionInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.renameSession({ sessionId: input.sessionId, title: input.title });
  },

  async selectWorkspaceSession(c: any, input: TaskWorkspaceSessionInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.selectSession({ sessionId: input.sessionId, authSessionId: input.authSessionId });
  },

  async setWorkspaceSessionUnread(c: any, input: TaskWorkspaceSetSessionUnreadInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.setSessionUnread({ sessionId: input.sessionId, unread: input.unread, authSessionId: input.authSessionId });
  },

  async updateWorkspaceDraft(c: any, input: TaskWorkspaceUpdateDraftInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task
      .updateDraft({
        sessionId: input.sessionId,
        text: input.text,
        attachments: input.attachments,
        authSessionId: input.authSessionId,
      })
      .catch(() => {});
  },

  async changeWorkspaceModel(c: any, input: TaskWorkspaceChangeModelInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.changeModel({ sessionId: input.sessionId, model: input.model, authSessionId: input.authSessionId });
  },

  async sendWorkspaceMessage(c: any, input: TaskWorkspaceSendMessageInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task
      .send(
        taskWorkflowQueueName("task.command.workspace.send_message"),
        {
          sessionId: input.sessionId,
          text: input.text,
          attachments: input.attachments,
          authSessionId: input.authSessionId,
        },
        { wait: false },
      )
      .catch(() => {});
  },

  async stopWorkspaceSession(c: any, input: TaskWorkspaceSessionInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task
      .send(taskWorkflowQueueName("task.command.workspace.stop_session"), { sessionId: input.sessionId, authSessionId: input.authSessionId }, { wait: false })
      .catch(() => {});
  },

  async closeWorkspaceSession(c: any, input: TaskWorkspaceSessionInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task
      .send(taskWorkflowQueueName("task.command.workspace.close_session"), { sessionId: input.sessionId, authSessionId: input.authSessionId }, { wait: false })
      .catch(() => {});
  },

  async publishWorkspacePr(c: any, input: TaskWorkspaceSelectInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task.send(taskWorkflowQueueName("task.command.workspace.publish_pr"), {}, { wait: false }).catch(() => {});
  },

  async changeWorkspaceTaskOwner(c: any, input: TaskWorkspaceChangeOwnerInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    await task.send(
      taskWorkflowQueueName("task.command.workspace.change_owner"),
      {
        primaryUserId: input.targetUserId,
        primaryGithubLogin: input.targetUserName,
        primaryGithubEmail: input.targetUserEmail,
        primaryGithubAvatarUrl: null,
      },
      { wait: false },
    );
  },

  async revertWorkspaceFile(c: any, input: TaskWorkspaceDiffInput): Promise<void> {
    const task = await requireWorkspaceTask(c, input.repoId, input.taskId);
    void task.send(taskWorkflowQueueName("task.command.workspace.revert_file"), input, { wait: false }).catch(() => {});
  },

  async getRepoOverview(c: any, input: RepoOverviewInput): Promise<RepoOverview> {
    assertOrganization(c, input.organizationId);

    return await getRepoOverviewFromOrg(c, input.repoId);
  },

  async listTasks(c: any, input: ListTasksInput): Promise<TaskSummary[]> {
    assertOrganization(c, input.organizationId);
    if (input.repoId) {
      return await listTaskSummariesForRepo(c, input.repoId, true);
    }
    return await listAllTaskSummaries(c, true);
  },

  async switchTask(c: any, input: { repoId: string; taskId: string }): Promise<SwitchResult> {
    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    const record = await h.get();
    const switched = expectQueueResponse<{ switchTarget: string | null }>(
      await h.send(taskWorkflowQueueName("task.command.switch"), {}, { wait: true, timeout: 10_000 }),
    );
    return {
      organizationId: c.state.organizationId,
      taskId: input.taskId,
      sandboxProviderId: record.sandboxProviderId,
      switchTarget: switched.switchTarget,
    };
  },

  async auditLog(c: any, input: HistoryQueryInput): Promise<AuditLogEvent[]> {
    assertOrganization(c, input.organizationId);
    const auditLog = await getOrCreateAuditLog(c, c.state.organizationId);
    return await auditLog.list({
      repoId: input.repoId,
      branch: input.branch,
      taskId: input.taskId,
      limit: input.limit ?? 20,
    });
  },

  async getTask(c: any, input: GetTaskInput): Promise<TaskRecord> {
    assertOrganization(c, input.organizationId);
    // Resolve repoId from local task index if not provided (e.g. sandbox actor only has taskId)
    const repoId = input.repoId || (await resolveTaskRepoId(c, input.taskId));
    // Use getOrCreate — the task may be virtual (PR-driven, no actor yet).
    // The task actor self-initializes in getCurrentRecord().
    const handle = await getOrCreateTask(c, c.state.organizationId, repoId, input.taskId, {
      organizationId: c.state.organizationId,
      repoId,
      taskId: input.taskId,
    });
    return await handle.get();
  },

  async attachTask(c: any, input: TaskProxyActionInput): Promise<{ target: string; sessionId: string | null }> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    return expectQueueResponse(await h.send(taskWorkflowQueueName("task.command.attach"), { reason: input.reason }, { wait: true, timeout: 10_000 }));
  },

  async pushTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    void h.send(taskWorkflowQueueName("task.command.push"), { reason: input.reason }, { wait: false }).catch(() => {});
  },

  async syncTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    void h.send(taskWorkflowQueueName("task.command.sync"), { reason: input.reason }, { wait: false }).catch(() => {});
  },

  async mergeTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    void h.send(taskWorkflowQueueName("task.command.merge"), { reason: input.reason }, { wait: false }).catch(() => {});
  },

  async archiveTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    void h.send(taskWorkflowQueueName("task.command.archive"), { reason: input.reason }, { wait: false }).catch(() => {});
  },

  async killTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);

    const h = getTaskHandle(c, c.state.organizationId, input.repoId, input.taskId);
    void h.send(taskWorkflowQueueName("task.command.kill"), { reason: input.reason }, { wait: false }).catch(() => {});
  },

  async getRepositoryMetadata(c: any, input: { repoId: string }): Promise<{ defaultBranch: string | null; fullName: string | null; remoteUrl: string }> {
    return await getRepositoryMetadataFromOrg(c, input.repoId);
  },

  async findTaskForBranch(c: any, input: { repoId: string; branchName: string }): Promise<{ taskId: string | null }> {
    return await findTaskForBranch(c, input.repoId, input.branchName);
  },

  /**
   * Lightweight read of task index + summary data. Used by the task actor
   * to self-initialize when lazily materialized from a virtual task.
   * Does NOT trigger materialization — no circular dependency.
   */
  async getTaskIndexEntry(c: any, input: { taskId: string }): Promise<{ branchName: string | null; title: string | null } | null> {
    const idx = await c.db.select({ branchName: taskIndex.branchName }).from(taskIndex).where(eq(taskIndex.taskId, input.taskId)).get();
    const summary = await c.db.select({ title: taskSummaries.title }).from(taskSummaries).where(eq(taskSummaries.taskId, input.taskId)).get();
    if (!idx && !summary) return null;
    return {
      branchName: idx?.branchName ?? null,
      title: summary?.title ?? null,
    };
  },
};
