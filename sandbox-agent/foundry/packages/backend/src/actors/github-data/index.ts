// @ts-nocheck
import { eq, inArray } from "drizzle-orm";
import { actor, queue } from "rivetkit";
import { workflow, Loop } from "rivetkit/workflow";
import type { FoundryOrganization } from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateOrganization, getTask } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { taskWorkflowQueueName } from "../task/workflow/queue.js";
import { repoIdFromRemote } from "../../services/repo.js";
import { resolveOrganizationGithubAuth } from "../../services/github-auth.js";
import { organizationWorkflowQueueName } from "../organization/queues.js";
import { githubDataDb } from "./db/db.js";
import { githubMembers, githubMeta, githubPullRequests, githubRepositories } from "./db/schema.js";

const META_ROW_ID = 1;
const SYNC_REPOSITORY_BATCH_SIZE = 10;

type GithubSyncPhase = "discovering_repositories" | "syncing_repositories" | "syncing_members" | "syncing_pull_requests";

interface GithubDataInput {
  organizationId: string;
}

interface GithubMemberRecord {
  id: string;
  login: string;
  name: string;
  email?: string | null;
  role?: string | null;
  state?: string | null;
}

interface GithubRepositoryRecord {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
}

interface GithubPullRequestRecord {
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
  updatedAt: number;
}

interface FullSyncInput {
  connectedAccount?: string | null;
  installationStatus?: FoundryOrganization["github"]["installationStatus"];
  installationId?: number | null;
  githubLogin?: string | null;
  kind?: FoundryOrganization["kind"] | null;
  accessToken?: string | null;
  label?: string | null;
}

interface ClearStateInput {
  connectedAccount: string;
  installationStatus: FoundryOrganization["github"]["installationStatus"];
  installationId: number | null;
  label: string;
}

// Queue names for github-data actor
export const GITHUB_DATA_QUEUE_NAMES = [
  "githubData.command.syncRepos",
  "githubData.command.handlePullRequestWebhook",
  "githubData.command.clearState",
] as const;

type GithubDataQueueName = (typeof GITHUB_DATA_QUEUE_NAMES)[number];

export function githubDataWorkflowQueueName(name: GithubDataQueueName): GithubDataQueueName {
  return name;
}

interface PullRequestWebhookInput {
  connectedAccount: string;
  installationStatus: FoundryOrganization["github"]["installationStatus"];
  installationId: number | null;
  repository: {
    fullName: string;
    cloneUrl: string;
    private: boolean;
  };
  pullRequest: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    authorLogin: string | null;
    isDraft: boolean;
    merged?: boolean;
  };
}

interface GithubMetaState {
  connectedAccount: string;
  installationStatus: FoundryOrganization["github"]["installationStatus"];
  syncStatus: FoundryOrganization["github"]["syncStatus"];
  installationId: number | null;
  lastSyncLabel: string;
  lastSyncAt: number | null;
  syncGeneration: number;
  syncPhase: GithubSyncPhase | null;
  processedRepositoryCount: number;
  totalRepositoryCount: number;
}

function normalizePrStatus(input: { state: string; isDraft?: boolean; merged?: boolean }): "OPEN" | "DRAFT" | "CLOSED" | "MERGED" {
  const state = input.state.trim().toUpperCase();
  if (input.merged || state === "MERGED") return "MERGED";
  if (state === "CLOSED") return "CLOSED";
  return input.isDraft ? "DRAFT" : "OPEN";
}

function pullRequestSummaryFromRow(row: any) {
  return {
    prId: row.prId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    number: row.number,
    status: Boolean(row.isDraft) ? "draft" : "ready",
    title: row.title,
    state: row.state,
    url: row.url,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    authorLogin: row.authorLogin ?? null,
    isDraft: Boolean(row.isDraft),
    updatedAtMs: row.updatedAt,
  };
}

function chunkItems<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function readMeta(c: any): Promise<GithubMetaState> {
  const row = await c.db.select().from(githubMeta).where(eq(githubMeta.id, META_ROW_ID)).get();
  return {
    connectedAccount: row?.connectedAccount ?? "",
    installationStatus: (row?.installationStatus ?? "install_required") as FoundryOrganization["github"]["installationStatus"],
    syncStatus: (row?.syncStatus ?? "pending") as FoundryOrganization["github"]["syncStatus"],
    installationId: row?.installationId ?? null,
    lastSyncLabel: row?.lastSyncLabel ?? "Waiting for first import",
    lastSyncAt: row?.lastSyncAt ?? null,
    syncGeneration: row?.syncGeneration ?? 0,
    syncPhase: (row?.syncPhase ?? null) as GithubSyncPhase | null,
    processedRepositoryCount: row?.processedRepositoryCount ?? 0,
    totalRepositoryCount: row?.totalRepositoryCount ?? 0,
  };
}

async function writeMeta(c: any, patch: Partial<GithubMetaState>) {
  const current = await readMeta(c);
  const next = {
    ...current,
    ...patch,
  };
  await c.db
    .insert(githubMeta)
    .values({
      id: META_ROW_ID,
      connectedAccount: next.connectedAccount,
      installationStatus: next.installationStatus,
      syncStatus: next.syncStatus,
      installationId: next.installationId,
      lastSyncLabel: next.lastSyncLabel,
      lastSyncAt: next.lastSyncAt,
      syncGeneration: next.syncGeneration,
      syncPhase: next.syncPhase,
      processedRepositoryCount: next.processedRepositoryCount,
      totalRepositoryCount: next.totalRepositoryCount,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: githubMeta.id,
      set: {
        connectedAccount: next.connectedAccount,
        installationStatus: next.installationStatus,
        syncStatus: next.syncStatus,
        installationId: next.installationId,
        lastSyncLabel: next.lastSyncLabel,
        lastSyncAt: next.lastSyncAt,
        syncGeneration: next.syncGeneration,
        syncPhase: next.syncPhase,
        processedRepositoryCount: next.processedRepositoryCount,
        totalRepositoryCount: next.totalRepositoryCount,
        updatedAt: Date.now(),
      },
    })
    .run();
  return next;
}

async function publishSyncProgress(c: any, patch: Partial<GithubMetaState>): Promise<GithubMetaState> {
  const meta = await writeMeta(c, patch);
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  await organization.send(
    organizationWorkflowQueueName("organization.command.github.sync_progress.apply"),
    {
      connectedAccount: meta.connectedAccount,
      installationStatus: meta.installationStatus,
      installationId: meta.installationId,
      syncStatus: meta.syncStatus,
      lastSyncLabel: meta.lastSyncLabel,
      lastSyncAt: meta.lastSyncAt,
      syncGeneration: meta.syncGeneration,
      syncPhase: meta.syncPhase,
      processedRepositoryCount: meta.processedRepositoryCount,
      totalRepositoryCount: meta.totalRepositoryCount,
    },
    { wait: false },
  );
  return meta;
}

async function getOrganizationContext(c: any, overrides?: FullSyncInput) {
  // Try to read the org profile for fallback values, but don't require it.
  // Webhook-triggered syncs can arrive before the user signs in and creates the
  // org profile row. The webhook callers already pass the necessary overrides
  // (connectedAccount, installationId, githubLogin, kind), so we can proceed
  // without the profile as long as overrides cover the required fields.
  const organizationHandle = await getOrCreateOrganization(c, c.state.organizationId);
  const organizationState = await organizationHandle.getOrganizationShellStateIfInitialized({});

  // If the org profile doesn't exist and overrides don't provide enough context, fail.
  if (!organizationState && !overrides?.connectedAccount) {
    throw new Error(`Organization ${c.state.organizationId} is not initialized and no override context was provided`);
  }

  const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
  return {
    kind: overrides?.kind ?? organizationState?.snapshot.kind,
    githubLogin: overrides?.githubLogin ?? organizationState?.githubLogin,
    connectedAccount: overrides?.connectedAccount ?? organizationState?.snapshot.github.connectedAccount ?? organizationState?.githubLogin,
    installationId: overrides?.installationId ?? organizationState?.githubInstallationId ?? null,
    installationStatus:
      overrides?.installationStatus ??
      organizationState?.snapshot.github.installationStatus ??
      (organizationState?.snapshot.kind === "personal" ? "connected" : "reconnect_required"),
    accessToken: overrides?.accessToken ?? auth?.githubToken ?? null,
  };
}

async function upsertRepositories(c: any, repositories: GithubRepositoryRecord[], updatedAt: number, syncGeneration: number) {
  for (const repository of repositories) {
    await c.db
      .insert(githubRepositories)
      .values({
        repoId: repoIdFromRemote(repository.cloneUrl),
        fullName: repository.fullName,
        cloneUrl: repository.cloneUrl,
        private: repository.private ? 1 : 0,
        defaultBranch: repository.defaultBranch,
        syncGeneration,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: githubRepositories.repoId,
        set: {
          fullName: repository.fullName,
          cloneUrl: repository.cloneUrl,
          private: repository.private ? 1 : 0,
          defaultBranch: repository.defaultBranch,
          syncGeneration,
          updatedAt,
        },
      })
      .run();
  }
}

async function sweepRepositories(c: any, syncGeneration: number) {
  const rows = await c.db.select({ repoId: githubRepositories.repoId, syncGeneration: githubRepositories.syncGeneration }).from(githubRepositories).all();
  for (const row of rows) {
    if (row.syncGeneration === syncGeneration) {
      continue;
    }
    await c.db.delete(githubRepositories).where(eq(githubRepositories.repoId, row.repoId)).run();
  }
}

async function upsertMembers(c: any, members: GithubMemberRecord[], updatedAt: number, syncGeneration: number) {
  for (const member of members) {
    await c.db
      .insert(githubMembers)
      .values({
        memberId: member.id,
        login: member.login,
        displayName: member.name || member.login,
        email: member.email ?? null,
        role: member.role ?? null,
        state: member.state ?? "active",
        syncGeneration,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: githubMembers.memberId,
        set: {
          login: member.login,
          displayName: member.name || member.login,
          email: member.email ?? null,
          role: member.role ?? null,
          state: member.state ?? "active",
          syncGeneration,
          updatedAt,
        },
      })
      .run();
  }
}

async function sweepMembers(c: any, syncGeneration: number) {
  const rows = await c.db.select({ memberId: githubMembers.memberId, syncGeneration: githubMembers.syncGeneration }).from(githubMembers).all();
  for (const row of rows) {
    if (row.syncGeneration === syncGeneration) {
      continue;
    }
    await c.db.delete(githubMembers).where(eq(githubMembers.memberId, row.memberId)).run();
  }
}

async function upsertPullRequests(c: any, pullRequests: GithubPullRequestRecord[], syncGeneration: number) {
  for (const pullRequest of pullRequests) {
    await c.db
      .insert(githubPullRequests)
      .values({
        prId: `${pullRequest.repoId}#${pullRequest.number}`,
        repoId: pullRequest.repoId,
        repoFullName: pullRequest.repoFullName,
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body ?? null,
        state: pullRequest.state,
        url: pullRequest.url,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        authorLogin: pullRequest.authorLogin ?? null,
        isDraft: pullRequest.isDraft ? 1 : 0,
        syncGeneration,
        updatedAt: pullRequest.updatedAt,
      })
      .onConflictDoUpdate({
        target: githubPullRequests.prId,
        set: {
          repoId: pullRequest.repoId,
          repoFullName: pullRequest.repoFullName,
          number: pullRequest.number,
          title: pullRequest.title,
          body: pullRequest.body ?? null,
          state: pullRequest.state,
          url: pullRequest.url,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          authorLogin: pullRequest.authorLogin ?? null,
          isDraft: pullRequest.isDraft ? 1 : 0,
          syncGeneration,
          updatedAt: pullRequest.updatedAt,
        },
      })
      .run();
  }
}

async function sweepPullRequests(c: any, syncGeneration: number) {
  const rows = await c.db.select({ prId: githubPullRequests.prId, syncGeneration: githubPullRequests.syncGeneration }).from(githubPullRequests).all();
  for (const row of rows) {
    if (row.syncGeneration === syncGeneration) {
      continue;
    }
    await c.db.delete(githubPullRequests).where(eq(githubPullRequests.prId, row.prId)).run();
  }
}

async function refreshTaskSummaryForBranch(c: any, repoId: string, branchName: string, pullRequest: ReturnType<typeof pullRequestSummaryFromRow> | null) {
  const repositoryRecord = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, repoId)).get();
  if (!repositoryRecord) {
    return;
  }
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  void organization
    .send(
      organizationWorkflowQueueName("organization.command.refreshTaskSummaryForBranch"),
      { repoId, branchName, pullRequest, repoName: repositoryRecord.fullName ?? undefined },
      { wait: false },
    )
    .catch(() => {});
}

async function emitPullRequestChangeEvents(c: any, beforeRows: any[], afterRows: any[]) {
  const beforeById = new Map(beforeRows.map((row) => [row.prId, row]));
  const afterById = new Map(afterRows.map((row) => [row.prId, row]));

  for (const [prId, row] of afterById) {
    const previous = beforeById.get(prId);
    const changed =
      !previous ||
      previous.title !== row.title ||
      previous.state !== row.state ||
      previous.url !== row.url ||
      previous.headRefName !== row.headRefName ||
      previous.baseRefName !== row.baseRefName ||
      previous.authorLogin !== row.authorLogin ||
      previous.isDraft !== row.isDraft ||
      previous.updatedAt !== row.updatedAt;
    if (!changed) {
      continue;
    }
    await refreshTaskSummaryForBranch(c, row.repoId, row.headRefName, pullRequestSummaryFromRow(row));
  }

  for (const [prId, row] of beforeById) {
    if (afterById.has(prId)) {
      continue;
    }
    await refreshTaskSummaryForBranch(c, row.repoId, row.headRefName, null);
  }
}

async function autoArchiveTaskForClosedPullRequest(c: any, row: any) {
  const repositoryRecord = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, row.repoId)).get();
  if (!repositoryRecord) {
    return;
  }
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  const match = await organization.findTaskForBranch({
    repoId: row.repoId,
    branchName: row.headRefName,
  });
  if (!match?.taskId) {
    return;
  }
  try {
    const task = getTask(c, c.state.organizationId, row.repoId, match.taskId);
    void task.send(taskWorkflowQueueName("task.command.archive"), { reason: `PR ${String(row.state).toLowerCase()}` }, { wait: false }).catch(() => {});
  } catch {
    // Best-effort only. Task summary refresh will still clear the PR state.
  }
}

async function resolveRepositories(c: any, context: Awaited<ReturnType<typeof getOrganizationContext>>): Promise<GithubRepositoryRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (context.kind === "personal") {
    if (!context.accessToken) {
      return [];
    }
    return await appShell.github.listUserRepositories(context.accessToken);
  }

  if (context.installationId != null) {
    try {
      return await appShell.github.listInstallationRepositories(context.installationId);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }

  if (!context.accessToken) {
    return [];
  }

  return (await appShell.github.listUserRepositories(context.accessToken)).filter((repository) => repository.fullName.startsWith(`${context.githubLogin}/`));
}

async function resolveMembers(c: any, context: Awaited<ReturnType<typeof getOrganizationContext>>): Promise<GithubMemberRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (context.kind === "personal") {
    return [];
  }
  if (context.installationId != null) {
    try {
      return await appShell.github.listInstallationMembers(context.installationId, context.githubLogin);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }
  if (!context.accessToken) {
    return [];
  }
  return await appShell.github.listOrganizationMembers(context.accessToken, context.githubLogin);
}

async function listPullRequestsForRepositories(
  context: Awaited<ReturnType<typeof getOrganizationContext>>,
  repositories: GithubRepositoryRecord[],
): Promise<GithubPullRequestRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (repositories.length === 0) {
    return [];
  }

  let pullRequests: Array<{
    repoFullName: string;
    cloneUrl: string;
    number: number;
    title: string;
    body?: string | null;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    authorLogin?: string | null;
    isDraft?: boolean;
    merged?: boolean;
  }> = [];

  if (context.installationId != null) {
    try {
      pullRequests = await appShell.github.listInstallationPullRequestsForRepositories(context.installationId, repositories);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }

  if (pullRequests.length === 0 && context.accessToken) {
    pullRequests = await appShell.github.listPullRequestsForUserRepositories(context.accessToken, repositories);
  }

  return pullRequests.map((pullRequest) => ({
    repoId: repoIdFromRemote(pullRequest.cloneUrl),
    repoFullName: pullRequest.repoFullName,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? null,
    state: normalizePrStatus(pullRequest),
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    authorLogin: pullRequest.authorLogin ?? null,
    isDraft: Boolean(pullRequest.isDraft),
    updatedAt: Date.now(),
  }));
}

async function readAllPullRequestRows(c: any) {
  return await c.db.select().from(githubPullRequests).all();
}

/** Config returned by fullSyncSetup, passed to subsequent sync phases. */
export interface FullSyncConfig {
  syncGeneration: number;
  startedAt: number;
  totalRepositoryCount: number;
  connectedAccount: string;
  installationStatus: string;
  installationId: number | null;
  beforePrRows: any[];
}

async function readRepositoriesFromDb(c: any): Promise<GithubRepositoryRecord[]> {
  const rows = await c.db.select().from(githubRepositories).all();
  return rows.map((r: any) => ({
    fullName: r.fullName,
    cloneUrl: r.cloneUrl,
    private: Boolean(r.private),
    defaultBranch: r.defaultBranch,
  }));
}

/**
 * Phase 1: Discover repositories and persist them.
 * Returns the config needed by all subsequent phases, or null if nothing to do.
 */
export async function fullSyncSetup(c: any, input: FullSyncInput = {}): Promise<FullSyncConfig> {
  const startedAt = Date.now();
  const beforePrRows = await readAllPullRequestRows(c);
  const currentMeta = await readMeta(c);
  const context = await getOrganizationContext(c, input);
  const syncGeneration = currentMeta.syncGeneration + 1;

  await publishSyncProgress(c, {
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    syncStatus: "syncing",
    lastSyncLabel: input.label?.trim() || "Syncing GitHub data...",
    syncGeneration,
    syncPhase: "discovering_repositories",
    processedRepositoryCount: 0,
    totalRepositoryCount: 0,
  });

  const repositories = await resolveRepositories(c, context);
  const totalRepositoryCount = repositories.length;

  await publishSyncProgress(c, {
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    syncStatus: "syncing",
    lastSyncLabel: totalRepositoryCount > 0 ? `Importing ${totalRepositoryCount} repositories...` : "No repositories available",
    syncGeneration,
    syncPhase: "syncing_repositories",
    processedRepositoryCount: totalRepositoryCount,
    totalRepositoryCount,
  });

  await upsertRepositories(c, repositories, startedAt, syncGeneration);

  return {
    syncGeneration,
    startedAt,
    totalRepositoryCount,
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    beforePrRows,
  };
}

/**
 * Phase 2: Resolve, upsert, and sweep members.
 */
export async function fullSyncMembers(c: any, config: FullSyncConfig): Promise<void> {
  await publishSyncProgress(c, {
    connectedAccount: config.connectedAccount,
    installationStatus: config.installationStatus,
    installationId: config.installationId,
    syncStatus: "syncing",
    lastSyncLabel: "Syncing GitHub members...",
    syncGeneration: config.syncGeneration,
    syncPhase: "syncing_members",
    processedRepositoryCount: config.totalRepositoryCount,
    totalRepositoryCount: config.totalRepositoryCount,
  });

  const context = await getOrganizationContext(c, {
    connectedAccount: config.connectedAccount,
    installationStatus: config.installationStatus as any,
    installationId: config.installationId,
  });
  const members = await resolveMembers(c, context);
  await upsertMembers(c, members, config.startedAt, config.syncGeneration);
  await sweepMembers(c, config.syncGeneration);
}

/**
 * Phase 3 (per-batch): Fetch and upsert pull requests for one batch of repos.
 * Returns true when all batches have been processed.
 */
export async function fullSyncPullRequestBatch(c: any, config: FullSyncConfig, batchIndex: number): Promise<boolean> {
  const repos = await readRepositoriesFromDb(c);
  const batches = chunkItems(repos, SYNC_REPOSITORY_BATCH_SIZE);
  if (batchIndex >= batches.length) return true;

  const batch = batches[batchIndex]!;
  const context = await getOrganizationContext(c, {
    connectedAccount: config.connectedAccount,
    installationStatus: config.installationStatus as any,
    installationId: config.installationId,
  });
  const batchPRs = await listPullRequestsForRepositories(context, batch);
  await upsertPullRequests(c, batchPRs, config.syncGeneration);

  const processedCount = Math.min((batchIndex + 1) * SYNC_REPOSITORY_BATCH_SIZE, repos.length);
  await publishSyncProgress(c, {
    connectedAccount: config.connectedAccount,
    installationStatus: config.installationStatus,
    installationId: config.installationId,
    syncStatus: "syncing",
    lastSyncLabel: `Synced pull requests for ${processedCount} of ${repos.length} repositories`,
    syncGeneration: config.syncGeneration,
    syncPhase: "syncing_pull_requests",
    processedRepositoryCount: processedCount,
    totalRepositoryCount: repos.length,
  });

  return false;
}

/**
 * Phase 4: Sweep stale data, publish final state, emit PR change events.
 */
export async function fullSyncFinalize(c: any, config: FullSyncConfig): Promise<void> {
  await sweepPullRequests(c, config.syncGeneration);
  await sweepRepositories(c, config.syncGeneration);

  await publishSyncProgress(c, {
    connectedAccount: config.connectedAccount,
    installationStatus: config.installationStatus,
    installationId: config.installationId,
    syncStatus: "synced",
    lastSyncLabel: config.totalRepositoryCount > 0 ? `Synced ${config.totalRepositoryCount} repositories` : "No repositories available",
    lastSyncAt: config.startedAt,
    syncGeneration: config.syncGeneration,
    syncPhase: null,
    processedRepositoryCount: config.totalRepositoryCount,
    totalRepositoryCount: config.totalRepositoryCount,
  });

  const afterRows = await readAllPullRequestRows(c);
  await emitPullRequestChangeEvents(c, config.beforePrRows, afterRows);
}

/**
 * Error handler: publish error sync state when a full sync fails.
 */
/**
 * Single-shot full sync: runs all phases (setup, branches, members, PRs, finalize)
 * using native JS loops. This must NOT use workflow primitives (step/loop/sleep)
 * because it runs inside a workflow step. See workflow.ts for context on why
 * sub-loops cause HistoryDivergedError.
 */
export async function runFullSync(c: any, input: FullSyncInput = {}): Promise<void> {
  const config = await fullSyncSetup(c, input);

  // Members
  await fullSyncMembers(c, config);

  // Pull requests — native loop over batches
  for (let i = 0; ; i++) {
    const done = await fullSyncPullRequestBatch(c, config, i);
    if (done) break;
  }

  // Finalize
  await fullSyncFinalize(c, config);
}

export async function fullSyncError(c: any, error: unknown): Promise<void> {
  const currentMeta = await readMeta(c);
  const message = error instanceof Error ? error.message : "GitHub import failed";
  await publishSyncProgress(c, {
    connectedAccount: currentMeta.connectedAccount,
    installationStatus: currentMeta.installationStatus,
    installationId: currentMeta.installationId,
    syncStatus: "error",
    lastSyncLabel: message,
    syncGeneration: currentMeta.syncGeneration,
    syncPhase: null,
    processedRepositoryCount: 0,
    totalRepositoryCount: 0,
  });
}

// ---------------------------------------------------------------------------
// Workflow command loop
// ---------------------------------------------------------------------------

type GithubDataWorkflowHandler = (loopCtx: any, body: any) => Promise<any>;

const GITHUB_DATA_COMMAND_HANDLERS: Record<GithubDataQueueName, GithubDataWorkflowHandler> = {
  "githubData.command.syncRepos": async (c, body) => {
    try {
      await runFullSync(c, body);
      return { ok: true };
    } catch (error) {
      try {
        await fullSyncError(c, error);
      } catch {
        /* best effort */
      }
      throw error;
    }
  },
  "githubData.command.handlePullRequestWebhook": async (c, body) => {
    await handlePullRequestWebhookMutation(c, body);
    return { ok: true };
  },
  "githubData.command.clearState": async (c, body) => {
    await clearStateMutation(c, body);
    return { ok: true };
  },
};

async function runGithubDataWorkflow(ctx: any): Promise<void> {
  await ctx.loop("github-data-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-github-data-command", {
      names: [...GITHUB_DATA_QUEUE_NAMES],
      completable: true,
    });

    if (!msg) {
      return Loop.continue(undefined);
    }

    const handler = GITHUB_DATA_COMMAND_HANDLERS[msg.name as GithubDataQueueName];
    if (!handler) {
      logActorWarning("github-data", "unknown github-data command", { command: msg.name });
      await msg.complete({ error: `Unknown command: ${msg.name}` }).catch(() => {});
      return Loop.continue(undefined);
    }

    try {
      // Wrap in a step so c.state and c.db are accessible inside mutation functions.
      const result = await loopCtx.step({
        name: msg.name,
        timeout: 10 * 60_000,
        run: async () => handler(loopCtx, msg.body),
      });
      await msg.complete(result);
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("github-data", "github-data workflow command failed", {
        command: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}

export const githubData = actor({
  db: githubDataDb,
  queues: Object.fromEntries(GITHUB_DATA_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "GitHub Data",
    icon: "github",
    actionTimeout: 10 * 60_000,
  },
  createState: (_c, input: GithubDataInput) => ({
    organizationId: input.organizationId,
  }),
  actions: {
    async getSummary(c) {
      const repositories = await c.db.select().from(githubRepositories).all();
      const members = await c.db.select().from(githubMembers).all();
      const pullRequests = await c.db.select().from(githubPullRequests).all();
      return {
        ...(await readMeta(c)),
        repositoryCount: repositories.length,
        memberCount: members.length,
        pullRequestCount: pullRequests.length,
      };
    },

    async listRepositories(c) {
      const rows = await c.db.select().from(githubRepositories).all();
      return rows.map((row) => ({
        repoId: row.repoId,
        fullName: row.fullName,
        cloneUrl: row.cloneUrl,
        private: Boolean(row.private),
        defaultBranch: row.defaultBranch,
      }));
    },

    async getRepository(c, input: { repoId: string }) {
      const row = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, input.repoId)).get();
      if (!row) {
        return null;
      }
      return {
        repoId: row.repoId,
        fullName: row.fullName,
        cloneUrl: row.cloneUrl,
        private: Boolean(row.private),
        defaultBranch: row.defaultBranch,
      };
    },

    async listOpenPullRequests(c) {
      const rows = await c.db
        .select()
        .from(githubPullRequests)
        .where(inArray(githubPullRequests.state, ["OPEN", "DRAFT"]))
        .all();
      return rows.map((row) => pullRequestSummaryFromRow(row));
    },
  },
  run: workflow(runGithubDataWorkflow),
});

export async function clearStateMutation(c: any, input: ClearStateInput) {
  const beforeRows = await readAllPullRequestRows(c);
  const currentMeta = await readMeta(c);
  await c.db.delete(githubPullRequests).run();
  await c.db.delete(githubRepositories).run();
  await c.db.delete(githubMembers).run();
  await writeMeta(c, {
    connectedAccount: input.connectedAccount,
    installationStatus: input.installationStatus,
    installationId: input.installationId,
    syncStatus: "pending",
    lastSyncLabel: input.label,
    lastSyncAt: null,
    syncGeneration: currentMeta.syncGeneration,
    syncPhase: null,
    processedRepositoryCount: 0,
    totalRepositoryCount: 0,
  });

  await emitPullRequestChangeEvents(c, beforeRows, []);
}

export async function handlePullRequestWebhookMutation(c: any, input: PullRequestWebhookInput) {
  const beforeRows = await readAllPullRequestRows(c);
  const repoId = repoIdFromRemote(input.repository.cloneUrl);
  const currentRepository = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, repoId)).get();
  const updatedAt = Date.now();
  const currentMeta = await readMeta(c);
  const state = normalizePrStatus(input.pullRequest);
  const prId = `${repoId}#${input.pullRequest.number}`;

  await c.db
    .insert(githubRepositories)
    .values({
      repoId,
      fullName: input.repository.fullName,
      cloneUrl: input.repository.cloneUrl,
      private: input.repository.private ? 1 : 0,
      defaultBranch: currentRepository?.defaultBranch ?? input.pullRequest.baseRefName ?? "main",
      syncGeneration: currentMeta.syncGeneration,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: githubRepositories.repoId,
      set: {
        fullName: input.repository.fullName,
        cloneUrl: input.repository.cloneUrl,
        private: input.repository.private ? 1 : 0,
        defaultBranch: currentRepository?.defaultBranch ?? input.pullRequest.baseRefName ?? "main",
        syncGeneration: currentMeta.syncGeneration,
        updatedAt,
      },
    })
    .run();

  if (state === "CLOSED" || state === "MERGED") {
    await c.db.delete(githubPullRequests).where(eq(githubPullRequests.prId, prId)).run();
  } else {
    await c.db
      .insert(githubPullRequests)
      .values({
        prId,
        repoId,
        repoFullName: input.repository.fullName,
        number: input.pullRequest.number,
        title: input.pullRequest.title,
        body: input.pullRequest.body ?? null,
        state,
        url: input.pullRequest.url,
        headRefName: input.pullRequest.headRefName,
        baseRefName: input.pullRequest.baseRefName,
        authorLogin: input.pullRequest.authorLogin ?? null,
        isDraft: input.pullRequest.isDraft ? 1 : 0,
        syncGeneration: currentMeta.syncGeneration,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: githubPullRequests.prId,
        set: {
          title: input.pullRequest.title,
          body: input.pullRequest.body ?? null,
          state,
          url: input.pullRequest.url,
          headRefName: input.pullRequest.headRefName,
          baseRefName: input.pullRequest.baseRefName,
          authorLogin: input.pullRequest.authorLogin ?? null,
          isDraft: input.pullRequest.isDraft ? 1 : 0,
          syncGeneration: currentMeta.syncGeneration,
          updatedAt,
        },
      })
      .run();
  }

  await publishSyncProgress(c, {
    connectedAccount: input.connectedAccount,
    installationStatus: input.installationStatus,
    installationId: input.installationId,
    syncStatus: "synced",
    lastSyncLabel: "GitHub webhook received",
    lastSyncAt: updatedAt,
    syncPhase: null,
    processedRepositoryCount: 0,
    totalRepositoryCount: 0,
  });

  const afterRows = await readAllPullRequestRows(c);
  await emitPullRequestChangeEvents(c, beforeRows, afterRows);
  if (state === "CLOSED" || state === "MERGED") {
    const previous = beforeRows.find((row) => row.prId === prId);
    if (previous) {
      await autoArchiveTaskForClosedPullRequest(c, {
        ...previous,
        state,
      });
    }
  }
}
