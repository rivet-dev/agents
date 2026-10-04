import type { FoundryAppSnapshot } from "./app-shell.js";
import type { OrganizationSummarySnapshot, WorkspaceSessionDetail, WorkspaceTaskDetail } from "./workspace.js";

export interface SandboxProcessSnapshot {
  id: string;
  command: string;
  args: string[];
  createdAtMs: number;
  cwd?: string | null;
  exitCode?: number | null;
  exitedAtMs?: number | null;
  interactive: boolean;
  pid?: number | null;
  status: "running" | "exited";
  tty: boolean;
}

/** Organization-level events broadcast by the organization actor. */
export type OrganizationEvent = { type: "organizationUpdated"; snapshot: OrganizationSummarySnapshot };

/** Task-level events broadcast by the task actor. */
export type TaskEvent = { type: "taskUpdated"; detail: WorkspaceTaskDetail };

/** Session-level events broadcast by the task actor and filtered by sessionId on the client. */
export type SessionEvent = { type: "sessionUpdated"; session: WorkspaceSessionDetail };

/** App-level events broadcast by the app organization actor. */
export type AppEvent = { type: "appUpdated"; snapshot: FoundryAppSnapshot };

/** Sandbox process events broadcast by the sandbox instance actor. */
export type SandboxProcessesEvent = { type: "processesUpdated"; processes: SandboxProcessSnapshot[] };
