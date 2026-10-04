import type { SandboxProviderId, TaskStatus } from "./contracts.js";
import type { WorkspaceAgentKind, WorkspaceModelGroup, WorkspaceModelId, WorkspaceModelOption } from "./models.js";

export type WorkspaceTaskStatus = TaskStatus;
export type WorkspaceSessionStatus = "pending_provision" | "pending_session_create" | "ready" | "running" | "idle" | "error";

export type { WorkspaceAgentKind, WorkspaceModelGroup, WorkspaceModelId, WorkspaceModelOption } from "./models.js";

export interface WorkspaceTranscriptEvent {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  connectionId: string;
  sender: "client" | "agent";
  payload: unknown;
}

export interface WorkspaceComposerDraft {
  text: string;
  attachments: WorkspaceLineAttachment[];
  updatedAtMs: number | null;
}

/** Session metadata without transcript content. */
export interface WorkspaceSessionSummary {
  id: string;
  /** Stable UI session id used for routing and task-local identity. */
  sessionId: string;
  /** Underlying sandbox session id when provisioning has completed. */
  sandboxSessionId?: string | null;
  sessionName: string;
  agent: WorkspaceAgentKind;
  model: WorkspaceModelId;
  status: WorkspaceSessionStatus;
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
  errorMessage?: string | null;
}

/** Full session content — only fetched when viewing a specific session. */
export interface WorkspaceSessionDetail {
  /** Stable UI session id used for the session topic key and routing. */
  sessionId: string;
  sandboxSessionId: string | null;
  sessionName: string;
  agent: WorkspaceAgentKind;
  model: WorkspaceModelId;
  status: WorkspaceSessionStatus;
  thinkingSinceMs: number | null;
  unread: boolean;
  created: boolean;
  errorMessage?: string | null;
  draft: WorkspaceComposerDraft;
  transcript: WorkspaceTranscriptEvent[];
}

export interface WorkspaceFileChange {
  path: string;
  added: number;
  removed: number;
  type: "M" | "A" | "D";
}

export interface WorkspaceFileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: WorkspaceFileTreeNode[];
}

export interface WorkspaceLineAttachment {
  id: string;
  filePath: string;
  lineNumber: number;
  lineContent: string;
}

export interface WorkspaceHistoryEvent {
  id: string;
  messageId: string;
  preview: string;
  sessionName: string;
  sessionId: string;
  createdAtMs: number;
  detail: string;
}

export type WorkspaceDiffLineKind = "context" | "add" | "remove" | "hunk";

export interface WorkspaceParsedDiffLine {
  kind: WorkspaceDiffLineKind;
  lineNumber: number;
  text: string;
}

export interface WorkspacePullRequestSummary {
  number: number;
  status: "draft" | "ready";
  title?: string;
  state?: string;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
  repoFullName?: string;
  authorLogin?: string | null;
  isDraft?: boolean;
  updatedAtMs?: number;
}

export interface WorkspaceSandboxSummary {
  sandboxProviderId: SandboxProviderId;
  sandboxId: string;
  cwd: string | null;
  url: string | null;
}

/** Sidebar-level task data. Materialized in the organization actor's SQLite. */
export interface WorkspaceTaskSummary {
  id: string;
  repoId: string;
  title: string;
  status: WorkspaceTaskStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkspacePullRequestSummary | null;
  activeSessionId: string | null;
  /** Summary of sessions — no transcript content. */
  sessionsSummary: WorkspaceSessionSummary[];
  /** GitHub login of the current primary user (task owner). */
  primaryUserLogin: string | null;
  /** Avatar URL of the current primary user. */
  primaryUserAvatarUrl: string | null;
}

/** Full task detail — only fetched when viewing a specific task. */
export interface WorkspaceTaskDetail extends WorkspaceTaskSummary {
  /** Original task prompt/instructions shown in the detail view. */
  task: string;
  fileChanges: WorkspaceFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkspaceFileTreeNode[];
  minutesUsed: number;
  /** Sandbox info for this task. */
  sandboxes: WorkspaceSandboxSummary[];
  activeSandboxId: string | null;
}

/** Repo-level summary for organization sidebar. */
export interface WorkspaceRepositorySummary {
  id: string;
  label: string;
  /** Aggregated branch/task overview state (replaces getRepoOverview polling). */
  taskCount: number;
  latestActivityMs: number;
}

export type OrganizationGithubSyncPhase =
  | "discovering_repositories"
  | "syncing_repositories"
  | "syncing_branches"
  | "syncing_members"
  | "syncing_pull_requests";

export interface OrganizationGithubSummary {
  connectedAccount: string;
  installationStatus: "connected" | "install_required" | "reconnect_required";
  syncStatus: "pending" | "syncing" | "synced" | "error";
  importedRepoCount: number;
  lastSyncLabel: string;
  lastSyncAt: number | null;
  lastWebhookAt: number | null;
  lastWebhookEvent: string;
  syncGeneration: number;
  syncPhase: OrganizationGithubSyncPhase | null;
  processedRepositoryCount: number;
  totalRepositoryCount: number;
}

export interface WorkspaceOpenPullRequest {
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  status: string;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
}

/** Organization-level snapshot — initial fetch for the organization topic. */
export interface OrganizationSummarySnapshot {
  organizationId: string;
  github: OrganizationGithubSummary;
  repos: WorkspaceRepositorySummary[];
  taskSummaries: WorkspaceTaskSummary[];
  openPullRequests?: WorkspaceOpenPullRequest[];
}

export interface WorkspaceSession extends WorkspaceSessionSummary {
  draft: WorkspaceComposerDraft;
  transcript: WorkspaceTranscriptEvent[];
}

export interface WorkspaceTask {
  id: string;
  repoId: string;
  title: string;
  status: WorkspaceTaskStatus;
  repoName: string;
  updatedAtMs: number;
  branch: string | null;
  pullRequest: WorkspacePullRequestSummary | null;
  activeSessionId?: string | null;
  sessions: WorkspaceSession[];
  fileChanges: WorkspaceFileChange[];
  diffs: Record<string, string>;
  fileTree: WorkspaceFileTreeNode[];
  minutesUsed: number;
  sandboxes?: WorkspaceSandboxSummary[];
  activeSandboxId?: string | null;
  /** GitHub login of the current primary user (task owner). */
  primaryUserLogin?: string | null;
  /** Avatar URL of the current primary user. */
  primaryUserAvatarUrl?: string | null;
}

export interface WorkspaceRepo {
  id: string;
  label: string;
}

export interface WorkspaceRepositorySection {
  id: string;
  label: string;
  updatedAtMs: number;
  tasks: WorkspaceTask[];
}

export interface TaskWorkspaceSnapshot {
  organizationId: string;
  repos: WorkspaceRepo[];
  repositories: WorkspaceRepositorySection[];
  tasks: WorkspaceTask[];
}

export interface TaskWorkspaceSelectInput {
  repoId: string;
  taskId: string;
  authSessionId?: string;
}

export interface TaskWorkspaceCreateTaskInput {
  repoId: string;
  task: string;
  title?: string;
  branch?: string;
  onBranch?: string;
  model?: WorkspaceModelId;
  authSessionId?: string;
}

export interface TaskWorkspaceRenameInput {
  repoId: string;
  taskId: string;
  value: string;
  authSessionId?: string;
}

export interface TaskWorkspaceSendMessageInput {
  repoId: string;
  taskId: string;
  sessionId: string;
  text: string;
  attachments: WorkspaceLineAttachment[];
  authSessionId?: string;
}

export interface TaskWorkspaceSessionInput {
  repoId: string;
  taskId: string;
  sessionId: string;
  authSessionId?: string;
}

export interface TaskWorkspaceRenameSessionInput extends TaskWorkspaceSessionInput {
  title: string;
}

export interface TaskWorkspaceChangeModelInput extends TaskWorkspaceSessionInput {
  model: WorkspaceModelId;
}

export interface TaskWorkspaceUpdateDraftInput extends TaskWorkspaceSessionInput {
  text: string;
  attachments: WorkspaceLineAttachment[];
}

export interface TaskWorkspaceSetSessionUnreadInput extends TaskWorkspaceSessionInput {
  unread: boolean;
}

export interface TaskWorkspaceChangeOwnerInput {
  repoId: string;
  taskId: string;
  /** User ID of the target owner (from FoundryOrganizationMember.id). */
  targetUserId: string;
  /** Display name to use as fallback if GitHub login cannot be resolved. */
  targetUserName: string;
  /** Email to use as fallback if GitHub email cannot be resolved. */
  targetUserEmail: string;
  authSessionId?: string;
}

export interface TaskWorkspaceDiffInput {
  repoId: string;
  taskId: string;
  path: string;
}

export interface TaskWorkspaceCreateTaskResponse {
  taskId: string;
  sessionId?: string;
}

export interface TaskWorkspaceAddSessionResponse {
  sessionId: string;
}
