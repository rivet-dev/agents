import { z } from "zod";

export const OrganizationIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;

export const SandboxProviderIdSchema = z.enum(["e2b", "local"]);
export type SandboxProviderId = z.infer<typeof SandboxProviderIdSchema>;

export const AgentTypeSchema = z.enum(["claude", "codex"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const RepoIdSchema = z.string().min(1).max(128);
export type RepoId = z.infer<typeof RepoIdSchema>;

export const RepoRemoteSchema = z.string().min(1).max(2048);
export type RepoRemote = z.infer<typeof RepoRemoteSchema>;

export const TaskStatusSchema = z.enum([
  "init_bootstrap_db",
  "init_enqueue_provision",
  "init_ensure_name",
  "init_assert_name",
  "init_complete",
  "running",
  "idle",
  "archive_stop_status_sync",
  "archive_release_sandbox",
  "archive_finalize",
  "archived",
  "kill_destroy_sandbox",
  "kill_finalize",
  "killed",
  "error",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const RepoRecordSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema,
  remoteUrl: RepoRemoteSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

export const CreateTaskInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema,
  task: z.string().min(1),
  explicitTitle: z.string().trim().min(1).optional(),
  explicitBranchName: z.string().trim().min(1).optional(),
  sandboxProviderId: SandboxProviderIdSchema.optional(),
  onBranch: z.string().trim().min(1).optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const WorkspacePullRequestSummarySchema = z.object({
  number: z.number().int(),
  status: z.enum(["draft", "ready"]),
  title: z.string().min(1),
  state: z.string().min(1),
  url: z.string().min(1),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  repoFullName: z.string().min(1),
  authorLogin: z.string().nullable(),
  isDraft: z.boolean(),
  updatedAtMs: z.number().int(),
});

export const TaskRecordSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: z.string().min(1),
  repoRemote: RepoRemoteSchema,
  taskId: z.string().min(1),
  branchName: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  task: z.string().min(1),
  sandboxProviderId: SandboxProviderIdSchema,
  status: TaskStatusSchema,
  activeSandboxId: z.string().nullable(),
  pullRequest: WorkspacePullRequestSummarySchema.nullable(),
  sandboxes: z.array(
    z.object({
      sandboxId: z.string().min(1),
      sandboxProviderId: SandboxProviderIdSchema,
      sandboxActorId: z.string().nullable(),
      switchTarget: z.string().min(1),
      cwd: z.string().nullable(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
    }),
  ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type TaskRecord = z.infer<typeof TaskRecordSchema>;

export const TaskSummarySchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: z.string().min(1),
  taskId: z.string().min(1),
  branchName: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  status: TaskStatusSchema,
  updatedAt: z.number().int(),
  pullRequest: WorkspacePullRequestSummarySchema.nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

export const TaskActionInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema,
  taskId: z.string().min(1),
});
export type TaskActionInput = z.infer<typeof TaskActionInputSchema>;

export const SwitchResultSchema = z.object({
  organizationId: OrganizationIdSchema,
  taskId: z.string().min(1),
  sandboxProviderId: SandboxProviderIdSchema,
  switchTarget: z.string().min(1),
});
export type SwitchResult = z.infer<typeof SwitchResultSchema>;

export const ListTasksInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema.optional(),
});
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

export const RepoBranchRecordSchema = z.object({
  branchName: z.string().min(1),
  commitSha: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  taskStatus: TaskStatusSchema.nullable(),
  pullRequest: WorkspacePullRequestSummarySchema.nullable(),
  ciStatus: z.string().nullable(),
  updatedAt: z.number().int(),
});
export type RepoBranchRecord = z.infer<typeof RepoBranchRecordSchema>;

export const RepoOverviewSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema,
  remoteUrl: RepoRemoteSchema,
  baseRef: z.string().nullable(),
  fetchedAt: z.number().int(),
  branches: z.array(RepoBranchRecordSchema),
});
export type RepoOverview = z.infer<typeof RepoOverviewSchema>;

export const OrganizationUseInputSchema = z.object({
  organizationId: OrganizationIdSchema,
});
export type OrganizationUseInput = z.infer<typeof OrganizationUseInputSchema>;

export const StarSandboxAgentRepoInputSchema = z.object({
  organizationId: OrganizationIdSchema,
});
export type StarSandboxAgentRepoInput = z.infer<typeof StarSandboxAgentRepoInputSchema>;

export const StarSandboxAgentRepoResultSchema = z.object({
  repo: z.string().min(1),
  starredAt: z.number().int(),
});
export type StarSandboxAgentRepoResult = z.infer<typeof StarSandboxAgentRepoResultSchema>;

export const HistoryQueryInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
  branch: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});
export type HistoryQueryInput = z.infer<typeof HistoryQueryInputSchema>;

export const AuditLogEventSchema = z.object({
  id: z.number().int(),
  organizationId: OrganizationIdSchema,
  repoId: z.string().nullable(),
  taskId: z.string().nullable(),
  branchName: z.string().nullable(),
  kind: z.string().min(1),
  payloadJson: z.string().min(1),
  createdAt: z.number().int(),
});
export type AuditLogEvent = z.infer<typeof AuditLogEventSchema>;

export const PruneInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  dryRun: z.boolean(),
  yes: z.boolean(),
});
export type PruneInput = z.infer<typeof PruneInputSchema>;

export const KillInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  repoId: RepoIdSchema,
  taskId: z.string().min(1),
  deleteBranch: z.boolean(),
  abandon: z.boolean(),
});
export type KillInput = z.infer<typeof KillInputSchema>;

export const StatuslineInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  format: z.enum(["table", "claude-code"]),
});
export type StatuslineInput = z.infer<typeof StatuslineInputSchema>;

export const ListInputSchema = z.object({
  organizationId: OrganizationIdSchema,
  format: z.enum(["table", "json"]),
  full: z.boolean(),
});
export type ListInput = z.infer<typeof ListInputSchema>;
