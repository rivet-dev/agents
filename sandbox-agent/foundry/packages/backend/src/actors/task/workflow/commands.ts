// @ts-nocheck
import { eq } from "drizzle-orm";
import { getTaskSandbox } from "../../handles.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { task as taskTable } from "../db/schema.js";
import { TASK_ROW_ID, appendAuditLog, getCurrentRecord, setTaskState } from "./common.js";
import { pushActiveBranchActivity } from "./push.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function handleAttachActivity(loopCtx: any, msg: any): Promise<void> {
  const record = await getCurrentRecord(loopCtx);
  let target = record.sandboxes.find((sandbox: any) => sandbox.sandboxId === record.activeSandboxId)?.switchTarget ?? "";
  const sessionId = msg.body?.sessionId ?? null;

  if (record.activeSandboxId) {
    try {
      const sandbox = getTaskSandbox(loopCtx, loopCtx.state.organizationId, record.activeSandboxId);
      const connection = await sandbox.sandboxAgentConnection();
      if (typeof connection?.endpoint === "string" && connection.endpoint.length > 0) {
        target = connection.endpoint;
      }
    } catch {
      // Best effort; keep the last known switch target if the sandbox actor is unavailable.
    }
  }

  await appendAuditLog(loopCtx, "task.attach", {
    target,
    sessionId,
  });

  await msg.complete({
    target,
    sessionId,
  });
}

export async function handleSwitchActivity(loopCtx: any, msg: any): Promise<void> {
  const db = loopCtx.db;
  const runtime = await db.select({ switchTarget: taskRuntime.activeSwitchTarget }).from(taskRuntime).where(eq(taskRuntime.id, TASK_ROW_ID)).get();

  await msg.complete({ switchTarget: runtime?.switchTarget ?? "" });
}

export async function handlePushActivity(loopCtx: any, msg: any): Promise<void> {
  await pushActiveBranchActivity(loopCtx, {
    reason: msg.body?.reason ?? null,
    historyKind: "task.push",
  });
  await msg.complete({ ok: true });
}

export async function handleSimpleCommandActivity(loopCtx: any, msg: any, historyKind: string): Promise<void> {
  await appendAuditLog(loopCtx, historyKind, { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleArchiveActivity(loopCtx: any, msg: any): Promise<void> {
  await setTaskState(loopCtx, "archive_stop_status_sync");
  const record = await getCurrentRecord(loopCtx);

  if (record.activeSandboxId) {
    await setTaskState(loopCtx, "archive_release_sandbox");
    void withTimeout(getTaskSandbox(loopCtx, loopCtx.state.organizationId, record.activeSandboxId).destroy(), 45_000, "sandbox destroy").catch((error) => {
      logActorWarning("task.commands", "failed to release sandbox during archive", {
        organizationId: loopCtx.state.organizationId,
        repoId: loopCtx.state.repoId,
        taskId: loopCtx.state.taskId,
        sandboxId: record.activeSandboxId,
        error: resolveErrorMessage(error),
      });
    });
  }

  const db = loopCtx.db;
  await setTaskState(loopCtx, "archive_finalize");
  await db.update(taskTable).set({ status: "archived", updatedAt: Date.now() }).where(eq(taskTable.id, TASK_ROW_ID)).run();

  await appendAuditLog(loopCtx, "task.archive", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function killDestroySandboxActivity(loopCtx: any): Promise<void> {
  await setTaskState(loopCtx, "kill_destroy_sandbox");
  const record = await getCurrentRecord(loopCtx);
  if (!record.activeSandboxId) {
    return;
  }

  await getTaskSandbox(loopCtx, loopCtx.state.organizationId, record.activeSandboxId).destroy();
}

export async function killWriteDbActivity(loopCtx: any, msg: any): Promise<void> {
  await setTaskState(loopCtx, "kill_finalize");
  const db = loopCtx.db;
  await db.update(taskTable).set({ status: "killed", updatedAt: Date.now() }).where(eq(taskTable.id, TASK_ROW_ID)).run();

  await appendAuditLog(loopCtx, "task.kill", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleGetActivity(loopCtx: any, msg: any): Promise<void> {
  await msg.complete(await getCurrentRecord(loopCtx));
}
