import type { TaskRecord, TaskStatus } from "@sandbox-agent/foundry-shared";

export const TASK_STATUS_GROUPS = ["queued", "running", "idle", "archived", "killed", "error"] as const;

export type TaskStatusGroup = (typeof TASK_STATUS_GROUPS)[number];

const QUEUED_STATUSES = new Set<TaskStatus>([
  "init_bootstrap_db",
  "init_enqueue_provision",
  "init_ensure_name",
  "init_assert_name",
  "init_complete",
  "archive_stop_status_sync",
  "archive_release_sandbox",
  "archive_finalize",
  "kill_destroy_sandbox",
  "kill_finalize",
]);

export function groupTaskStatus(status: TaskStatus): TaskStatusGroup {
  if (status === "running") return "running";
  if (status === "idle") return "idle";
  if (status === "archived") return "archived";
  if (status === "killed") return "killed";
  if (status === "error") return "error";
  if (QUEUED_STATUSES.has(status)) return "queued";
  return "queued";
}

function emptyStatusCounts(): Record<TaskStatusGroup, number> {
  return {
    queued: 0,
    running: 0,
    idle: 0,
    archived: 0,
    killed: 0,
    error: 0,
  };
}

export interface TaskSummary {
  total: number;
  byStatus: Record<TaskStatusGroup, number>;
  byProvider: Record<string, number>;
}

export function fuzzyMatch(target: string, query: string): boolean {
  const haystack = target.toLowerCase();
  const needle = query.toLowerCase();
  let i = 0;
  for (const ch of needle) {
    i = haystack.indexOf(ch, i);
    if (i < 0) {
      return false;
    }
    i += 1;
  }
  return true;
}

export function filterTasks(rows: TaskRecord[], query: string): TaskRecord[] {
  const q = query.trim();
  if (!q) {
    return rows;
  }

  return rows.filter((row) => {
    const fields = [row.branchName ?? "", row.title ?? "", row.taskId, row.task];
    return fields.some((field) => fuzzyMatch(field, q));
  });
}

export function formatRelativeAge(updatedAt: number, now = Date.now()): string {
  const deltaSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function summarizeTasks(rows: TaskRecord[]): TaskSummary {
  const byStatus = emptyStatusCounts();
  const byProvider: Record<string, number> = {};

  for (const row of rows) {
    byStatus[groupTaskStatus(row.status)] += 1;
    byProvider[row.sandboxProviderId] = (byProvider[row.sandboxProviderId] ?? 0) + 1;
  }

  return {
    total: rows.length,
    byStatus,
    byProvider,
  };
}
