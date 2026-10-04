import type { TaskStatus, WorkspaceSessionStatus } from "@sandbox-agent/foundry-shared";
import type { HeaderStatusInfo } from "../../components/mock-layout/ui";

export type TaskDisplayStatus = TaskStatus;

export interface TaskStateDescriptor {
  title: string;
  detail: string;
}

export function isProvisioningTaskStatus(status: TaskDisplayStatus | null | undefined): boolean {
  return status === "init_bootstrap_db" || status === "init_enqueue_provision" || status === "init_ensure_name" || status === "init_assert_name";
}

export function defaultTaskStatusMessage(status: TaskDisplayStatus | null | undefined): string {
  switch (status) {
    case "init_bootstrap_db":
      return "Creating task records.";
    case "init_enqueue_provision":
      return "Queueing sandbox provisioning.";
    case "init_ensure_name":
      return "Determining title and branch.";
    case "init_assert_name":
      return "Validating title and branch.";
    case "init_complete":
      return "Finalizing task initialization.";
    case "running":
      return "Agent session is actively running.";
    case "idle":
      return "Sandbox is ready for the next prompt.";
    case "archive_stop_status_sync":
      return "Stopping sandbox status sync before archiving.";
    case "archive_release_sandbox":
      return "Releasing sandbox resources.";
    case "archive_finalize":
      return "Finalizing archive.";
    case "archived":
      return "Task has been archived.";
    case "kill_destroy_sandbox":
      return "Destroying sandbox resources.";
    case "kill_finalize":
      return "Finalizing task termination.";
    case "killed":
      return "Task has been terminated.";
    case "error":
      return "Task entered an error state.";
    case null:
    case undefined:
      return "Task state unavailable.";
  }
}

export function resolveTaskStateDetail(status: TaskDisplayStatus | null | undefined): string {
  return defaultTaskStatusMessage(status);
}

export function describeTaskState(status: TaskDisplayStatus | null | undefined): TaskStateDescriptor {
  return {
    title: status ? `Task state: ${status}` : "Task state unavailable",
    detail: resolveTaskStateDetail(status),
  };
}

/**
 * Derives the header status pill state from the combined task + active session + sandbox state.
 * Priority: session error > task error > no sandbox > provisioning > running > ready/idle > neutral.
 */
export function deriveHeaderStatus(
  taskStatus: TaskDisplayStatus | null | undefined,
  sessionStatus: WorkspaceSessionStatus | null | undefined,
  sessionErrorMessage: string | null | undefined,
  hasSandbox?: boolean,
): HeaderStatusInfo {
  // Session error takes priority
  if (sessionStatus === "error") {
    return {
      variant: "error",
      label: "Session error",
      spinning: false,
      tooltip: sessionErrorMessage ?? "Session failed to start.",
    };
  }

  // Task error
  if (taskStatus === "error") {
    return {
      variant: "error",
      label: "Error",
      spinning: false,
      tooltip: "Task entered an error state.",
    };
  }

  // No sandbox available (not provisioning, not errored — just missing)
  if (hasSandbox === false && !isProvisioningTaskStatus(taskStatus)) {
    return {
      variant: "warning",
      label: "No sandbox",
      spinning: false,
      tooltip: "Sandbox is not available for this task.",
    };
  }

  // Task provisioning (init_* states)
  if (isProvisioningTaskStatus(taskStatus)) {
    return {
      variant: "warning",
      label: "Provisioning",
      spinning: true,
      tooltip: resolveTaskStateDetail(taskStatus),
    };
  }

  // Session pending states
  if (sessionStatus === "pending_provision") {
    return {
      variant: "warning",
      label: "Provisioning",
      spinning: true,
      tooltip: "Provisioning sandbox...",
    };
  }

  if (sessionStatus === "pending_session_create") {
    return {
      variant: "warning",
      label: "Creating session",
      spinning: true,
      tooltip: "Creating agent session...",
    };
  }

  // Running
  if (sessionStatus === "running") {
    return {
      variant: "success",
      label: "Running",
      spinning: true,
      tooltip: "Agent is actively running.",
    };
  }

  // Ready / idle
  if (sessionStatus === "ready" || sessionStatus === "idle" || taskStatus === "idle" || taskStatus === "running") {
    return {
      variant: "success",
      label: "Ready",
      spinning: false,
      tooltip: "Sandbox is ready.",
    };
  }

  // Terminal states
  if (taskStatus === "archived" || taskStatus === "killed") {
    return {
      variant: "neutral",
      label: taskStatus === "archived" ? "Archived" : "Terminated",
      spinning: false,
    };
  }

  // Fallback
  return {
    variant: "neutral",
    label: taskStatus ?? "Unknown",
    spinning: false,
  };
}
