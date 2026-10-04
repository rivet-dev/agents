import { eq, and } from "drizzle-orm";
import { DEFAULT_WORKSPACE_MODEL_ID } from "@sandbox-agent/foundry-shared";
import { authAccounts, authSessions, authUsers, sessionState, userProfiles, userTaskState } from "../db/schema.js";
import { materializeRow } from "../query-helpers.js";

export const userActions = {
  // Custom Foundry action — not part of Better Auth.
  async getAppAuthState(c, input: { sessionId: string }) {
    const session = await c.db.select().from(authSessions).where(eq(authSessions.id, input.sessionId)).get();
    if (!session) {
      return null;
    }
    const [user, profile, currentSessionState, accounts] = await Promise.all([
      c.db.select().from(authUsers).where(eq(authUsers.authUserId, session.userId)).get(),
      c.db.select().from(userProfiles).where(eq(userProfiles.userId, session.userId)).get(),
      c.db.select().from(sessionState).where(eq(sessionState.sessionId, input.sessionId)).get(),
      c.db.select().from(authAccounts).where(eq(authAccounts.userId, session.userId)).all(),
    ]);
    return {
      session,
      user: materializeRow("user", user),
      profile: profile ?? null,
      sessionState: currentSessionState ?? null,
      accounts,
    };
  },

  // Custom Foundry action — not part of Better Auth.
  async getTaskState(c, input: { taskId: string }) {
    const rows = await c.db.select().from(userTaskState).where(eq(userTaskState.taskId, input.taskId)).all();
    const activeSessionId = rows.find((row) => typeof row.activeSessionId === "string" && row.activeSessionId.length > 0)?.activeSessionId ?? null;
    return {
      taskId: input.taskId,
      activeSessionId,
      sessions: rows.map((row) => ({
        sessionId: row.sessionId,
        unread: row.unread === 1,
        draftText: row.draftText,
        draftAttachmentsJson: row.draftAttachmentsJson,
        draftUpdatedAt: row.draftUpdatedAt ?? null,
        updatedAt: row.updatedAt,
      })),
    };
  },

  // --- Mutation actions (migrated from queue) ---

  async upsertProfile(
    c,
    input: {
      userId: string;
      patch: {
        githubAccountId?: string | null;
        githubLogin?: string | null;
        roleLabel?: string;
        defaultModel?: string;
        eligibleOrganizationIdsJson?: string;
        starterRepoStatus?: string;
        starterRepoStarredAt?: number | null;
        starterRepoSkippedAt?: number | null;
      };
    },
  ) {
    const now = Date.now();
    await c.db
      .insert(userProfiles)
      .values({
        id: 1,
        userId: input.userId,
        githubAccountId: input.patch.githubAccountId ?? null,
        githubLogin: input.patch.githubLogin ?? null,
        roleLabel: input.patch.roleLabel ?? "GitHub user",
        defaultModel: input.patch.defaultModel ?? DEFAULT_WORKSPACE_MODEL_ID,
        eligibleOrganizationIdsJson: input.patch.eligibleOrganizationIdsJson ?? "[]",
        starterRepoStatus: input.patch.starterRepoStatus ?? "pending",
        starterRepoStarredAt: input.patch.starterRepoStarredAt ?? null,
        starterRepoSkippedAt: input.patch.starterRepoSkippedAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: {
          ...(input.patch.githubAccountId !== undefined ? { githubAccountId: input.patch.githubAccountId } : {}),
          ...(input.patch.githubLogin !== undefined ? { githubLogin: input.patch.githubLogin } : {}),
          ...(input.patch.roleLabel !== undefined ? { roleLabel: input.patch.roleLabel } : {}),
          ...(input.patch.defaultModel !== undefined ? { defaultModel: input.patch.defaultModel } : {}),
          ...(input.patch.eligibleOrganizationIdsJson !== undefined ? { eligibleOrganizationIdsJson: input.patch.eligibleOrganizationIdsJson } : {}),
          ...(input.patch.starterRepoStatus !== undefined ? { starterRepoStatus: input.patch.starterRepoStatus } : {}),
          ...(input.patch.starterRepoStarredAt !== undefined ? { starterRepoStarredAt: input.patch.starterRepoStarredAt } : {}),
          ...(input.patch.starterRepoSkippedAt !== undefined ? { starterRepoSkippedAt: input.patch.starterRepoSkippedAt } : {}),
          updatedAt: now,
        },
      })
      .run();
    return await c.db.select().from(userProfiles).where(eq(userProfiles.userId, input.userId)).get();
  },

  async upsertSessionState(c, input: { sessionId: string; activeOrganizationId: string | null }) {
    const now = Date.now();
    await c.db
      .insert(sessionState)
      .values({
        sessionId: input.sessionId,
        activeOrganizationId: input.activeOrganizationId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sessionState.sessionId,
        set: { activeOrganizationId: input.activeOrganizationId, updatedAt: now },
      })
      .run();
    return await c.db.select().from(sessionState).where(eq(sessionState.sessionId, input.sessionId)).get();
  },

  async upsertTaskState(
    c,
    input: {
      taskId: string;
      sessionId: string;
      patch: {
        activeSessionId?: string | null;
        unread?: boolean;
        draftText?: string;
        draftAttachmentsJson?: string;
        draftUpdatedAt?: number | null;
      };
    },
  ) {
    const now = Date.now();
    const existing = await c.db
      .select()
      .from(userTaskState)
      .where(and(eq(userTaskState.taskId, input.taskId), eq(userTaskState.sessionId, input.sessionId)))
      .get();

    if (input.patch.activeSessionId !== undefined) {
      await c.db
        .update(userTaskState)
        .set({ activeSessionId: input.patch.activeSessionId, updatedAt: now })
        .where(eq(userTaskState.taskId, input.taskId))
        .run();
    }

    await c.db
      .insert(userTaskState)
      .values({
        taskId: input.taskId,
        sessionId: input.sessionId,
        activeSessionId: input.patch.activeSessionId ?? existing?.activeSessionId ?? null,
        unread: input.patch.unread !== undefined ? (input.patch.unread ? 1 : 0) : (existing?.unread ?? 0),
        draftText: input.patch.draftText ?? existing?.draftText ?? "",
        draftAttachmentsJson: input.patch.draftAttachmentsJson ?? existing?.draftAttachmentsJson ?? "[]",
        draftUpdatedAt: input.patch.draftUpdatedAt === undefined ? (existing?.draftUpdatedAt ?? null) : input.patch.draftUpdatedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userTaskState.taskId, userTaskState.sessionId],
        set: {
          ...(input.patch.activeSessionId !== undefined ? { activeSessionId: input.patch.activeSessionId } : {}),
          ...(input.patch.unread !== undefined ? { unread: input.patch.unread ? 1 : 0 } : {}),
          ...(input.patch.draftText !== undefined ? { draftText: input.patch.draftText } : {}),
          ...(input.patch.draftAttachmentsJson !== undefined ? { draftAttachmentsJson: input.patch.draftAttachmentsJson } : {}),
          ...(input.patch.draftUpdatedAt !== undefined ? { draftUpdatedAt: input.patch.draftUpdatedAt } : {}),
          updatedAt: now,
        },
      })
      .run();

    return await c.db
      .select()
      .from(userTaskState)
      .where(and(eq(userTaskState.taskId, input.taskId), eq(userTaskState.sessionId, input.sessionId)))
      .get();
  },

  async deleteTaskState(c, input: { taskId: string; sessionId?: string }) {
    if (input.sessionId) {
      await c.db
        .delete(userTaskState)
        .where(and(eq(userTaskState.taskId, input.taskId), eq(userTaskState.sessionId, input.sessionId)))
        .run();
      return;
    }
    await c.db.delete(userTaskState).where(eq(userTaskState.taskId, input.taskId)).run();
  },
};
