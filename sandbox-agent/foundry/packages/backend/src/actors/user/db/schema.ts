import { check, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { DEFAULT_WORKSPACE_MODEL_ID } from "@sandbox-agent/foundry-shared";

/** Better Auth core model — schema defined at https://better-auth.com/docs/concepts/database */
export const authUsers = sqliteTable(
  "user",
  {
    id: integer("id").primaryKey(),
    authUserId: text("auth_user_id").notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified").notNull(),
    image: text("image"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    authUserIdIdx: uniqueIndex("user_auth_user_id_idx").on(table.authUserId),
    singletonCheck: check("user_singleton_id_check", sql`${table.id} = 1`),
  }),
);

/** Better Auth core model — schema defined at https://better-auth.com/docs/concepts/database */
export const authSessions = sqliteTable(
  "session",
  {
    id: text("id").notNull().primaryKey(),
    token: text("token").notNull(),
    userId: text("user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    tokenIdx: uniqueIndex("session_token_idx").on(table.token),
  }),
);

/** Better Auth core model — schema defined at https://better-auth.com/docs/concepts/database */
export const authAccounts = sqliteTable(
  "account",
  {
    id: text("id").notNull().primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex("account_provider_account_idx").on(table.providerId, table.accountId),
  }),
);

/** Custom Foundry table — not part of Better Auth. */
export const userProfiles = sqliteTable(
  "user_profiles",
  {
    id: integer("id").primaryKey(),
    userId: text("user_id").notNull(),
    githubAccountId: text("github_account_id"),
    githubLogin: text("github_login"),
    roleLabel: text("role_label").notNull(),
    defaultModel: text("default_model").notNull().default(DEFAULT_WORKSPACE_MODEL_ID),
    eligibleOrganizationIdsJson: text("eligible_organization_ids_json").notNull(),
    starterRepoStatus: text("starter_repo_status").notNull(),
    starterRepoStarredAt: integer("starter_repo_starred_at"),
    starterRepoSkippedAt: integer("starter_repo_skipped_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    userIdIdx: uniqueIndex("user_profiles_user_id_idx").on(table.userId),
    singletonCheck: check("user_profiles_singleton_id_check", sql`${table.id} = 1`),
  }),
);

/** Custom Foundry table — not part of Better Auth. */
export const sessionState = sqliteTable("session_state", {
  sessionId: text("session_id").notNull().primaryKey(),
  activeOrganizationId: text("active_organization_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Custom Foundry table — not part of Better Auth. Stores per-user task/session UI state. */
export const userTaskState = sqliteTable(
  "user_task_state",
  {
    taskId: text("task_id").notNull(),
    sessionId: text("session_id").notNull(),
    activeSessionId: text("active_session_id"),
    unread: integer("unread").notNull().default(0),
    draftText: text("draft_text").notNull().default(""),
    draftAttachmentsJson: text("draft_attachments_json").notNull().default("[]"),
    draftUpdatedAt: integer("draft_updated_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.taskId, table.sessionId] }),
  }),
);
