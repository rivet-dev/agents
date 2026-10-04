// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import type {
  RepoRecord,
  WorkspaceRepositorySummary,
  WorkspaceTaskSummary,
  OrganizationEvent,
  OrganizationGithubSummary,
  OrganizationSummarySnapshot,
  OrganizationUseInput,
} from "@sandbox-agent/foundry-shared";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { getOrCreateGithubData } from "../handles.js";
import { organizationProfile, taskSummaries } from "./db/schema.js";
import { organizationAppActions } from "./actions/app.js";
import { organizationBetterAuthActions } from "./actions/better-auth.js";
import { organizationOnboardingActions } from "./actions/onboarding.js";
import { organizationGithubActions } from "./actions/github.js";
import { organizationShellActions } from "./actions/organization.js";
import { organizationTaskActions } from "./actions/tasks.js";
import { updateOrganizationShellProfileMutation } from "./app-shell.js";

interface OrganizationState {
  organizationId: string;
}

const ORGANIZATION_PROFILE_ROW_ID = 1;

function assertOrganization(c: { state: OrganizationState }, organizationId: string): void {
  if (organizationId !== c.state.organizationId) {
    throw new Error(`Organization actor mismatch: actor=${c.state.organizationId} command=${organizationId}`);
  }
}

function repoLabelFromRemote(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl.startsWith("http") ? remoteUrl : `https://${remoteUrl}`);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/, "")}`;
    }
  } catch {
    // ignore
  }

  return remoteUrl;
}

function buildGithubSummary(profile: any, importedRepoCount: number): OrganizationGithubSummary {
  return {
    connectedAccount: profile?.githubConnectedAccount ?? "",
    installationStatus: profile?.githubInstallationStatus ?? "install_required",
    syncStatus: profile?.githubSyncStatus ?? "pending",
    importedRepoCount,
    lastSyncLabel: profile?.githubLastSyncLabel ?? "Waiting for first import",
    lastSyncAt: profile?.githubLastSyncAt ?? null,
    lastWebhookAt: profile?.githubLastWebhookAt ?? null,
    lastWebhookEvent: profile?.githubLastWebhookEvent ?? "",
    syncGeneration: profile?.githubSyncGeneration ?? 0,
    syncPhase: profile?.githubSyncPhase ?? null,
    processedRepositoryCount: profile?.githubProcessedRepositoryCount ?? 0,
    totalRepositoryCount: profile?.githubTotalRepositoryCount ?? 0,
  };
}

/**
 * Reads the organization sidebar snapshot from local tables only — no fan-out
 * to child actors. Task summaries are organization-owned and updated via push
 * from task actors.
 */
async function getOrganizationSummarySnapshot(c: any): Promise<OrganizationSummarySnapshot> {
  const profile = await c.db.select().from(organizationProfile).where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID)).get();

  // Fetch repos + open PRs from github-data actor (single actor, not fan-out)
  let repoRows: Array<{ repoId: string; fullName: string; cloneUrl: string; private: boolean; defaultBranch: string }> = [];
  let openPullRequests: any[] = [];
  try {
    const githubData = await getOrCreateGithubData(c, c.state.organizationId);
    [repoRows, openPullRequests] = await Promise.all([githubData.listRepositories({}), githubData.listOpenPullRequests({})]);
  } catch {
    // github-data actor may not exist yet
  }

  const summaryRows = await c.db.select().from(taskSummaries).orderBy(desc(taskSummaries.updatedAtMs)).all();
  const summaries = summaryRows.map((row) => ({
    id: row.taskId,
    repoId: row.repoId,
    title: row.title,
    status: row.status,
    repoName: row.repoName,
    updatedAtMs: row.updatedAtMs,
    branch: row.branch ?? null,
    pullRequest: row.pullRequestJson
      ? (() => {
          try {
            return JSON.parse(row.pullRequestJson);
          } catch {
            return null;
          }
        })()
      : null,
    sessionsSummary: row.sessionsSummaryJson
      ? (() => {
          try {
            return JSON.parse(row.sessionsSummaryJson);
          } catch {
            return [];
          }
        })()
      : [],
  }));

  return {
    organizationId: c.state.organizationId,
    github: buildGithubSummary(profile, repoRows.length),
    repos: repoRows
      .map((repo) => {
        const repoTasks = summaries.filter((t) => t.repoId === repo.repoId);
        const latestTaskMs = repoTasks.reduce((latest, t) => Math.max(latest, t.updatedAtMs), 0);
        return {
          id: repo.repoId,
          label: repoLabelFromRemote(repo.cloneUrl),
          taskCount: repoTasks.length,
          latestActivityMs: latestTaskMs || Date.now(),
        };
      })
      .sort((a, b) => b.latestActivityMs - a.latestActivityMs),
    taskSummaries: summaries,
    openPullRequests,
  };
}

export async function refreshOrganizationSnapshotMutation(c: any): Promise<void> {
  c.broadcast("organizationUpdated", {
    type: "organizationUpdated",
    snapshot: await getOrganizationSummarySnapshot(c),
  } satisfies OrganizationEvent);
}

export const organizationActions = {
  ...organizationBetterAuthActions,
  ...organizationGithubActions,
  ...organizationOnboardingActions,
  ...organizationShellActions,
  ...organizationAppActions,
  ...organizationTaskActions,
  async useOrganization(c: any, input: OrganizationUseInput): Promise<{ organizationId: string }> {
    assertOrganization(c, input.organizationId);
    return { organizationId: c.state.organizationId };
  },

  async listRepos(c: any, input: OrganizationUseInput): Promise<RepoRecord[]> {
    assertOrganization(c, input.organizationId);
    try {
      const githubData = await getOrCreateGithubData(c, c.state.organizationId);
      const rows = await githubData.listRepositories({});
      return rows.map((row: any) => ({
        organizationId: c.state.organizationId,
        repoId: row.repoId,
        remoteUrl: row.cloneUrl,
        createdAt: row.updatedAt ?? Date.now(),
        updatedAt: row.updatedAt ?? Date.now(),
      }));
    } catch {
      return [];
    }
  },

  async getOrganizationSummary(c: any, input: OrganizationUseInput): Promise<OrganizationSummarySnapshot> {
    assertOrganization(c, input.organizationId);
    return await getOrganizationSummarySnapshot(c);
  },

  // updateShellProfile stays as a direct action — called with await from HTTP handler where the user can retry
  async updateShellProfile(c: any, input: { displayName?: string; slug?: string; primaryDomain?: string }): Promise<void> {
    await updateOrganizationShellProfileMutation(c, input);
  },
};

export async function applyGithubSyncProgressMutation(
  c: any,
  input: {
    connectedAccount: string;
    installationStatus: string;
    installationId: number | null;
    syncStatus: string;
    lastSyncLabel: string;
    lastSyncAt: number | null;
    syncGeneration: number;
    syncPhase: string | null;
    processedRepositoryCount: number;
    totalRepositoryCount: number;
  },
): Promise<void> {
  const profile = await c.db
    .select({ id: organizationProfile.id })
    .from(organizationProfile)
    .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
    .get();
  if (!profile) {
    return;
  }

  await c.db
    .update(organizationProfile)
    .set({
      githubConnectedAccount: input.connectedAccount,
      githubInstallationStatus: input.installationStatus,
      githubSyncStatus: input.syncStatus,
      githubInstallationId: input.installationId,
      githubLastSyncLabel: input.lastSyncLabel,
      githubLastSyncAt: input.lastSyncAt,
      githubSyncGeneration: input.syncGeneration,
      githubSyncPhase: input.syncPhase,
      githubProcessedRepositoryCount: input.processedRepositoryCount,
      githubTotalRepositoryCount: input.totalRepositoryCount,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
    .run();

  await refreshOrganizationSnapshotMutation(c);
}

export async function recordGithubWebhookReceiptMutation(
  c: any,
  input: {
    organizationId: string;
    event: string;
    action?: string | null;
    receivedAt?: number;
  },
): Promise<void> {
  assertOrganization(c, input.organizationId);

  const profile = await c.db
    .select({ id: organizationProfile.id })
    .from(organizationProfile)
    .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
    .get();
  if (!profile) {
    return;
  }

  await c.db
    .update(organizationProfile)
    .set({
      githubLastWebhookAt: input.receivedAt ?? Date.now(),
      githubLastWebhookEvent: input.action ? `${input.event}.${input.action}` : input.event,
    })
    .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
    .run();
}
