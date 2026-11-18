import { check, integer, sqliteTable, text } from "rivetkit/db/drizzle";
import { sql } from "drizzle-orm";

// SQLite is per task actor instance, so these tables only ever store one row (id=1).
export const task = sqliteTable(
  "task",
  {
    id: integer("id").primaryKey(),
    branchName: text("branch_name"),
    title: text("title"),
    task: text("task").notNull(),
    sandboxProviderId: text("sandbox_provider_id").notNull(),
    status: text("status").notNull(),
    pullRequestJson: text("pull_request_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("task_singleton_id_check", sql`${table.id} = 1`)],
);

export const taskRuntime = sqliteTable(
  "task_runtime",
  {
    id: integer("id").primaryKey(),
    activeSandboxId: text("active_sandbox_id"),
    activeSwitchTarget: text("active_switch_target"),
    activeCwd: text("active_cwd"),
    gitStateJson: text("git_state_json"),
    gitStateUpdatedAt: integer("git_state_updated_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("task_runtime_singleton_id_check", sql`${table.id} = 1`)],
);

/**
 * Coordinator index of SandboxInstanceActor instances.
 * Tracks all sandbox instances provisioned for this task. Only one
 * is active at a time (referenced by taskRuntime.activeSandboxId).
 */
export const taskSandboxes = sqliteTable("task_sandboxes", {
  sandboxId: text("sandbox_id").notNull().primaryKey(),
  sandboxProviderId: text("sandbox_provider_id").notNull(),
  sandboxActorId: text("sandbox_actor_id"),
  switchTarget: text("switch_target").notNull(),
  cwd: text("cwd"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Single-row table tracking the primary user (owner) of this task.
 * The owner's GitHub OAuth credentials are injected into the sandbox
 * for git operations. Updated when a different user sends a message.
 */
export const taskOwner = sqliteTable(
  "task_owner",
  {
    id: integer("id").primaryKey(),
    primaryUserId: text("primary_user_id"),
    primaryGithubLogin: text("primary_github_login"),
    primaryGithubEmail: text("primary_github_email"),
    primaryGithubAvatarUrl: text("primary_github_avatar_url"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("task_owner_singleton_id_check", sql`${table.id} = 1`)],
);

/**
 * Coordinator index of workspace sessions within this task.
 * The task actor is the coordinator for sessions. Each row holds session
 * metadata, model, status, transcript, and draft state. Sessions are
 * sub-entities of the task — no separate session actor in the DB.
 */
export const taskWorkspaceSessions = sqliteTable("task_workspace_sessions", {
  sessionId: text("session_id").notNull().primaryKey(),
  sandboxSessionId: text("sandbox_session_id"),
  sessionName: text("session_name").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("ready"),
  errorMessage: text("error_message"),
  transcriptJson: text("transcript_json").notNull().default("[]"),
  transcriptUpdatedAt: integer("transcript_updated_at"),
  created: integer("created").notNull().default(1),
  closed: integer("closed").notNull().default(0),
  thinkingSinceMs: integer("thinking_since_ms"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
