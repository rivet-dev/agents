// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { selfTask } from "../../handles.js";
import { resolveErrorMessage } from "../../logging.js";
import { taskWorkflowQueueName } from "./queue.js";
import { defaultSandboxProviderId } from "../../../sandbox-config.js";
import { task as taskTable, taskRuntime } from "../db/schema.js";
import { TASK_ROW_ID, appendAuditLog, collectErrorMessages, resolveErrorDetail, setTaskState } from "./common.js";
// task actions called directly (no queue)

export async function initBootstrapDbActivity(loopCtx: any, body: any): Promise<void> {
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = body?.sandboxProviderId ?? defaultSandboxProviderId(config);
  const task = body?.task;
  if (typeof task !== "string" || task.trim().length === 0) {
    throw new Error("task initialize requires the task prompt");
  }
  const now = Date.now();

  await loopCtx.db
    .insert(taskTable)
    .values({
      id: TASK_ROW_ID,
      branchName: body?.branchName ?? null,
      title: body?.title ?? null,
      task,
      sandboxProviderId,
      status: "init_bootstrap_db",
      pullRequestJson: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskTable.id,
      set: {
        branchName: body?.branchName ?? null,
        title: body?.title ?? null,
        task,
        sandboxProviderId,
        status: "init_bootstrap_db",
        pullRequestJson: null,
        updatedAt: now,
      },
    })
    .run();

  await loopCtx.db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: null,
      activeSwitchTarget: null,
      activeCwd: null,
      gitStateJson: null,
      gitStateUpdatedAt: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskRuntime.id,
      set: {
        activeSandboxId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        updatedAt: now,
      },
    })
    .run();
}

export async function initEnqueueProvisionActivity(loopCtx: any, body: any): Promise<void> {
  await setTaskState(loopCtx, "init_enqueue_provision");

  const self = selfTask(loopCtx);
  try {
    void self.send(taskWorkflowQueueName("task.command.provision"), body ?? {}, { wait: false }).catch(() => {});
  } catch (error) {
    logActorWarning("task.init", "background provision command failed", {
      organizationId: loopCtx.state.organizationId,
      repoId: loopCtx.state.repoId,
      taskId: loopCtx.state.taskId,
      error: resolveErrorMessage(error),
    });
    throw error;
  }
}

export async function initCompleteActivity(loopCtx: any, body: any): Promise<void> {
  const now = Date.now();
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = body?.sandboxProviderId ?? defaultSandboxProviderId(config);

  await setTaskState(loopCtx, "init_complete");
  await loopCtx.db
    .update(taskRuntime)
    .set({
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  await appendAuditLog(loopCtx, "task.initialized", {
    payload: { sandboxProviderId },
  });
}

export async function initFailedActivity(loopCtx: any, error: unknown, body?: any): Promise<void> {
  const now = Date.now();
  const detail = resolveErrorDetail(error);
  const messages = collectErrorMessages(error);
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = defaultSandboxProviderId(config);
  const task = typeof body?.task === "string" ? body.task : null;

  await loopCtx.db
    .insert(taskTable)
    .values({
      id: TASK_ROW_ID,
      branchName: body?.branchName ?? null,
      title: body?.title ?? null,
      task: task ?? detail,
      sandboxProviderId,
      status: "error",
      pullRequestJson: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskTable.id,
      set: {
        branchName: body?.branchName ?? null,
        title: body?.title ?? null,
        task: task ?? detail,
        sandboxProviderId,
        status: "error",
        pullRequestJson: null,
        updatedAt: now,
      },
    })
    .run();

  await loopCtx.db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: null,
      activeSwitchTarget: null,
      activeCwd: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskRuntime.id,
      set: {
        activeSandboxId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        updatedAt: now,
      },
    })
    .run();

  await appendAuditLog(loopCtx, "task.error", {
    detail,
    messages,
  });
}
