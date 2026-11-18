import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  FoundryBillingState,
  FoundryOrganization,
  FoundryOrganizationMember,
  FoundryUser,
  UpdateFoundryOrganizationProfileInput,
  WorkspaceModelId,
} from "@sandbox-agent/foundry-shared";
import { DEFAULT_WORKSPACE_MODEL_ID } from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateGithubData, getOrCreateOrganization, selfOrganization } from "../handles.js";
import { GitHubAppError } from "../../services/app-github.js";
import { getBetterAuthService } from "../../services/better-auth.js";
import { repoLabelFromRemote } from "../../services/repo.js";
import { logger } from "../../logging.js";
import { githubDataWorkflowQueueName } from "../github-data/index.js";
import { organizationWorkflowQueueName } from "./queues.js";
import { invoices, organizationMembers, organizationProfile, seatAssignments, stripeLookup } from "./db/schema.js";
import { APP_SHELL_ORGANIZATION_ID } from "./constants.js";

const githubWebhookLogger = logger.child({
  scope: "github-webhook",
});

const PROFILE_ROW_ID = 1;

function roundDurationMs(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

export function assertAppOrganization(c: any): void {
  if (c.state.organizationId !== APP_SHELL_ORGANIZATION_ID) {
    throw new Error(`App shell action requires organization ${APP_SHELL_ORGANIZATION_ID}, got ${c.state.organizationId}`);
  }
}

export function assertOrganizationShell(c: any): void {
  if (c.state.organizationId === APP_SHELL_ORGANIZATION_ID) {
    throw new Error("Organization action cannot run on the reserved app organization");
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function personalOrganizationId(login: string): string {
  return `personal-${slugify(login)}`;
}

function organizationOrganizationId(kind: FoundryOrganization["kind"], login: string): string {
  return kind === "personal" ? personalOrganizationId(login) : slugify(login);
}

function parseEligibleOrganizationIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

function encodeEligibleOrganizationIds(value: string[]): string {
  return JSON.stringify([...new Set(value)]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seatsIncludedForPlan(planId: FoundryBillingPlanId): number {
  switch (planId) {
    case "free":
      return 1;
    case "team":
      return 5;
  }
}

function stripeStatusToBillingStatus(stripeStatus: string, cancelAtPeriodEnd: boolean): FoundryBillingState["status"] {
  if (cancelAtPeriodEnd) {
    return "scheduled_cancel";
  }
  if (stripeStatus === "trialing") {
    return "trialing";
  }
  if (stripeStatus === "past_due" || stripeStatus === "unpaid" || stripeStatus === "incomplete") {
    return "past_due";
  }
  return "active";
}

function formatUnixDate(value: number): string {
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function legacyRepoImportStatusToGithubSyncStatus(value: string | null | undefined): FoundryOrganization["github"]["syncStatus"] {
  switch (value) {
    case "ready":
      return "synced";
    case "importing":
      return "syncing";
    default:
      return "pending";
  }
}

function stringFromMetadata(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stripeWebhookSubscription(event: any) {
  const object = event.data.object as Record<string, unknown>;
  const items = (object.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
  const price = items[0]?.price as Record<string, unknown> | undefined;
  return {
    id: typeof object.id === "string" ? object.id : "",
    customerId: typeof object.customer === "string" ? object.customer : "",
    priceId: typeof price?.id === "string" ? price.id : null,
    status: typeof object.status === "string" ? object.status : "active",
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    currentPeriodEnd: typeof object.current_period_end === "number" ? object.current_period_end : null,
    trialEnd: typeof object.trial_end === "number" ? object.trial_end : null,
    defaultPaymentMethodLabel: "Payment method on file",
  };
}

// sendOrganizationCommand removed — org actions called directly

export async function getOrganizationState(organization: any) {
  return await organization.getOrganizationShellState({});
}

async function getOrganizationStateIfInitialized(organization: any) {
  return await organization.getOrganizationShellStateIfInitialized({});
}

async function listSnapshotOrganizations(c: any, sessionId: string, organizationIds: string[]) {
  const results = await Promise.all(
    organizationIds.map(async (organizationId) => {
      const organizationStartedAt = performance.now();
      try {
        const organization = await getOrCreateOrganization(c, organizationId);
        const organizationState = await getOrganizationStateIfInitialized(organization);
        if (!organizationState) {
          logger.warn(
            {
              sessionId,
              actorOrganizationId: c.state.organizationId,
              organizationId,
              durationMs: roundDurationMs(organizationStartedAt),
            },
            "build_app_snapshot_organization_uninitialized",
          );
          return { organizationId, snapshot: null, status: "uninitialized" as const };
        }
        logger.info(
          {
            sessionId,
            actorOrganizationId: c.state.organizationId,
            organizationId,
            durationMs: roundDurationMs(organizationStartedAt),
          },
          "build_app_snapshot_organization_completed",
        );
        return { organizationId, snapshot: organizationState.snapshot, status: "ok" as const };
      } catch (error) {
        const message = errorMessage(error);
        if (!message.includes("Actor not found")) {
          logger.error(
            {
              sessionId,
              actorOrganizationId: c.state.organizationId,
              organizationId,
              durationMs: roundDurationMs(organizationStartedAt),
              errorMessage: message,
              errorStack: error instanceof Error ? error.stack : undefined,
            },
            "build_app_snapshot_organization_failed",
          );
          throw error;
        }
        logger.info(
          {
            sessionId,
            actorOrganizationId: c.state.organizationId,
            organizationId,
            durationMs: roundDurationMs(organizationStartedAt),
          },
          "build_app_snapshot_organization_missing",
        );
        return { organizationId, snapshot: null, status: "missing" as const };
      }
    }),
  );

  return {
    organizations: results.map((result) => result.snapshot).filter((organization): organization is FoundryOrganization => organization !== null),
    uninitializedOrganizationIds: results.filter((result) => result.status === "uninitialized").map((result) => result.organizationId),
  };
}

export async function buildAppSnapshot(c: any, sessionId: string, allowOrganizationRepair = true): Promise<FoundryAppSnapshot> {
  assertAppOrganization(c);
  const startedAt = performance.now();
  const auth = getBetterAuthService();
  let authState = await auth.getAuthState(sessionId);
  // Inline fallback: if the user is signed in but has no eligible organizations yet
  // (e.g. first load after OAuth callback), sync GitHub orgs before building the snapshot.
  if (authState?.user && parseEligibleOrganizationIds(authState.profile?.eligibleOrganizationIdsJson ?? "[]").length === 0) {
    const token = await auth.getAccessTokenForSession(sessionId);
    if (token?.accessToken) {
      logger.info({ sessionId }, "build_app_snapshot_sync_orgs");
      await syncGithubOrganizations(c, { sessionId, accessToken: token.accessToken });
      authState = await auth.getAuthState(sessionId);
    } else {
      logger.warn({ sessionId }, "build_app_snapshot_no_access_token");
    }
  }

  const session = authState?.session ?? null;
  const user = authState?.user ?? null;
  const profile = authState?.profile ?? null;
  const currentSessionState = authState?.sessionState ?? null;
  const githubAccount = authState?.accounts?.find((account: any) => account.providerId === "github") ?? null;
  const eligibleOrganizationIds = parseEligibleOrganizationIds(profile?.eligibleOrganizationIdsJson ?? "[]");

  logger.info(
    {
      sessionId,
      organizationId: c.state.organizationId,
      eligibleOrganizationCount: eligibleOrganizationIds.length,
      eligibleOrganizationIds,
    },
    "build_app_snapshot_started",
  );

  let { organizations, uninitializedOrganizationIds } = await listSnapshotOrganizations(c, sessionId, eligibleOrganizationIds);

  if (allowOrganizationRepair && uninitializedOrganizationIds.length > 0) {
    const token = await auth.getAccessTokenForSession(sessionId);
    if (token?.accessToken) {
      logger.info(
        {
          sessionId,
          organizationId: c.state.organizationId,
          organizationIds: uninitializedOrganizationIds,
        },
        "build_app_snapshot_repairing_organizations",
      );
      await syncGithubOrganizationsInternal(c, { sessionId, accessToken: token.accessToken }, { broadcast: false });
      return await buildAppSnapshot(c, sessionId, false);
    }
    logger.warn(
      {
        sessionId,
        organizationId: c.state.organizationId,
        organizationIds: uninitializedOrganizationIds,
      },
      "build_app_snapshot_repair_skipped_no_access_token",
    );
  }

  const currentUser: FoundryUser | null = user
    ? {
        id: profile?.githubAccountId ?? githubAccount?.accountId ?? user.id,
        name: user.name,
        email: user.email,
        githubLogin: profile?.githubLogin ?? "",
        roleLabel: profile?.roleLabel ?? "GitHub user",
        eligibleOrganizationIds,
        defaultModel: profile?.defaultModel ?? DEFAULT_WORKSPACE_MODEL_ID,
      }
    : null;

  const activeOrganizationId =
    currentUser &&
    currentSessionState?.activeOrganizationId &&
    organizations.some((organization) => organization.id === currentSessionState.activeOrganizationId)
      ? currentSessionState.activeOrganizationId
      : currentUser && organizations.length === 1
        ? (organizations[0]?.id ?? null)
        : null;

  const snapshot: FoundryAppSnapshot = {
    auth: {
      status: currentUser ? "signed_in" : "signed_out",
      currentUserId: currentUser?.id ?? null,
    },
    activeOrganizationId,
    onboarding: {
      starterRepo: {
        repoFullName: "rivet-dev/sandbox-agent",
        repoUrl: "https://github.com/rivet-dev/sandbox-agent",
        status: profile?.starterRepoStatus ?? "pending",
        starredAt: profile?.starterRepoStarredAt ?? null,
        skippedAt: profile?.starterRepoSkippedAt ?? null,
      },
    },
    users: currentUser ? [currentUser] : [],
    organizations,
  };

  logger.info(
    {
      sessionId,
      organizationId: c.state.organizationId,
      eligibleOrganizationCount: eligibleOrganizationIds.length,
      organizationCount: organizations.length,
      durationMs: roundDurationMs(startedAt),
    },
    "build_app_snapshot_completed",
  );

  return snapshot;
}

export async function requireSignedInSession(c: any, sessionId: string) {
  const auth = getBetterAuthService();
  const authState = await auth.getAuthState(sessionId);
  const user = authState?.user ?? null;
  const profile = authState?.profile ?? null;
  const githubAccount = authState?.accounts?.find((account: any) => account.providerId === "github") ?? null;
  if (!authState?.session || !user?.email) {
    throw new Error("User must be signed in");
  }
  const token = await auth.getAccessTokenForSession(sessionId);
  return {
    ...authState.session,
    authUserId: user.id,
    currentUserId: profile?.githubAccountId ?? githubAccount?.accountId ?? user.id,
    currentUserName: user.name,
    currentUserEmail: user.email,
    currentUserGithubLogin: profile?.githubLogin ?? "",
    currentUserRoleLabel: profile?.roleLabel ?? "GitHub user",
    eligibleOrganizationIdsJson: profile?.eligibleOrganizationIdsJson ?? "[]",
    githubAccessToken: token?.accessToken ?? null,
    githubScope: (token?.scopes ?? []).join(","),
    starterRepoStatus: profile?.starterRepoStatus ?? "pending",
    starterRepoStarredAt: profile?.starterRepoStarredAt ?? null,
    starterRepoSkippedAt: profile?.starterRepoSkippedAt ?? null,
  };
}

export function requireEligibleOrganization(session: any, organizationId: string): void {
  const eligibleOrganizationIds = parseEligibleOrganizationIds(session.eligibleOrganizationIdsJson);
  if (!eligibleOrganizationIds.includes(organizationId)) {
    throw new Error(`Organization ${organizationId} is not available in this app session`);
  }
}

async function upsertStripeLookupEntries(c: any, organizationId: string, customerId: string | null, subscriptionId: string | null): Promise<void> {
  assertAppOrganization(c);
  const now = Date.now();
  for (const lookupKey of [customerId ? `customer:${customerId}` : null, subscriptionId ? `subscription:${subscriptionId}` : null]) {
    if (!lookupKey) {
      continue;
    }
    await c.db
      .insert(stripeLookup)
      .values({
        lookupKey,
        organizationId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: stripeLookup.lookupKey,
        set: {
          organizationId,
          updatedAt: now,
        },
      })
      .run();
  }
}

async function findOrganizationIdForStripeEvent(c: any, customerId: string | null, subscriptionId: string | null): Promise<string | null> {
  assertAppOrganization(c);
  const customerLookup = customerId
    ? await c.db
        .select({ organizationId: stripeLookup.organizationId })
        .from(stripeLookup)
        .where(eq(stripeLookup.lookupKey, `customer:${customerId}`))
        .get()
    : null;
  if (customerLookup?.organizationId) {
    return customerLookup.organizationId;
  }

  const subscriptionLookup = subscriptionId
    ? await c.db
        .select({ organizationId: stripeLookup.organizationId })
        .from(stripeLookup)
        .where(eq(stripeLookup.lookupKey, `subscription:${subscriptionId}`))
        .get()
    : null;
  return subscriptionLookup?.organizationId ?? null;
}

async function safeListOrganizations(accessToken: string): Promise<any[]> {
  const { appShell } = getActorRuntimeContext();
  try {
    return await appShell.github.listOrganizations(accessToken);
  } catch (error) {
    if (error instanceof GitHubAppError && error.status === 403) {
      return [];
    }
    throw error;
  }
}

async function safeListInstallations(accessToken: string): Promise<any[]> {
  const { appShell } = getActorRuntimeContext();
  try {
    return await appShell.github.listInstallations(accessToken);
  } catch (error) {
    if (error instanceof GitHubAppError && (error.status === 403 || error.status === 404)) {
      return [];
    }
    throw error;
  }
}

/**
 * Slow path: list GitHub orgs + installations, sync each org organization,
 * and update the session's eligible organization list. Called from the
 * workflow queue so it runs in the background after the callback has
 * already returned a redirect to the browser.
 */
export async function syncGithubOrganizations(c: any, input: { sessionId: string; accessToken: string }): Promise<void> {
  await syncGithubOrganizationsInternal(c, input, { broadcast: true });
}

async function syncGithubOrganizationsInternal(c: any, input: { sessionId: string; accessToken: string }, options: { broadcast: boolean }): Promise<void> {
  assertAppOrganization(c);
  const auth = getBetterAuthService();
  const { appShell } = getActorRuntimeContext();
  const { sessionId, accessToken } = input;
  const authState = await auth.getAuthState(sessionId);
  if (!authState?.user) {
    throw new Error("User must be signed in");
  }
  const viewer = await appShell.github.getViewer(accessToken);
  const organizations = await safeListOrganizations(accessToken);
  const installations = await safeListInstallations(accessToken);
  const authUserId = authState.user.id;
  const githubUserId = String(viewer.id);

  const linkedOrganizationIds: string[] = [];
  const accounts = [
    {
      githubAccountId: viewer.id,
      githubLogin: viewer.login,
      githubAccountType: "User",
      kind: "personal" as const,
      displayName: viewer.name || viewer.login,
    },
    ...organizations.map((organization) => ({
      githubAccountId: organization.id,
      githubLogin: organization.login,
      githubAccountType: "Organization",
      kind: "organization" as const,
      displayName: organization.name || organization.login,
    })),
  ];

  for (const account of accounts) {
    const organizationId = organizationOrganizationId(account.kind, account.githubLogin);
    const installation = installations.find((candidate) => candidate.accountLogin === account.githubLogin) ?? null;
    const organization = await getOrCreateOrganization(c, organizationId);
    await organization.send(
      organizationWorkflowQueueName("organization.command.github.organization_shell.sync_from_github"),
      {
        userId: githubUserId,
        userName: viewer.name || viewer.login,
        userEmail: viewer.email ?? `${viewer.login}@users.noreply.github.com`,
        githubUserLogin: viewer.login,
        githubAccountId: account.githubAccountId,
        githubLogin: account.githubLogin,
        githubAccountType: account.githubAccountType,
        kind: account.kind,
        displayName: account.displayName,
        installationId: installation?.id ?? null,
        appConfigured: appShell.github.isAppConfigured(),
      },
      { wait: true, timeout: 10_000 },
    );
    linkedOrganizationIds.push(organizationId);
  }

  const activeOrganizationId =
    authState.sessionState?.activeOrganizationId && linkedOrganizationIds.includes(authState.sessionState.activeOrganizationId)
      ? authState.sessionState.activeOrganizationId
      : linkedOrganizationIds.length === 1
        ? (linkedOrganizationIds[0] ?? null)
        : null;

  await auth.setActiveOrganization(sessionId, activeOrganizationId);
  await auth.upsertUserProfile(authUserId, {
    githubAccountId: String(viewer.id),
    githubLogin: viewer.login,
    roleLabel: "GitHub user",
    eligibleOrganizationIdsJson: encodeEligibleOrganizationIds(linkedOrganizationIds),
  });
  if (!options.broadcast) {
    return;
  }
  c.broadcast("appUpdated", {
    type: "appUpdated",
    snapshot: await buildAppSnapshot(c, sessionId),
  });
}

async function readOrganizationProfileRow(c: any) {
  assertOrganizationShell(c);
  return await c.db.select().from(organizationProfile).where(eq(organizationProfile.id, PROFILE_ROW_ID)).get();
}

async function requireOrganizationProfileRow(c: any) {
  const row = await readOrganizationProfileRow(c);
  if (!row) {
    throw new Error(`Organization profile is not initialized for organization ${c.state.organizationId}`);
  }
  return row;
}

async function listOrganizationMembers(c: any): Promise<FoundryOrganizationMember[]> {
  assertOrganizationShell(c);
  const rows = await c.db.select().from(organizationMembers).orderBy(organizationMembers.role, organizationMembers.name).all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    state: row.state,
  }));
}

async function listOrganizationSeatAssignments(c: any): Promise<string[]> {
  assertOrganizationShell(c);
  const rows = await c.db.select({ email: seatAssignments.email }).from(seatAssignments).orderBy(seatAssignments.email).all();
  return rows.map((row) => row.email);
}

async function listOrganizationInvoices(c: any): Promise<FoundryBillingState["invoices"]> {
  assertOrganizationShell(c);
  const rows = await c.db.select().from(invoices).orderBy(desc(invoices.issuedAt), desc(invoices.createdAt)).all();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    issuedAt: row.issuedAt,
    amountUsd: row.amountUsd,
    status: row.status,
  }));
}

async function listOrganizationRepoCatalog(c: any): Promise<string[]> {
  assertOrganizationShell(c);
  try {
    const githubData = await getOrCreateGithubData(c, c.state.organizationId);
    const rows = await githubData.listRepositories({});
    return rows.map((row: any) => repoLabelFromRemote(row.cloneUrl)).sort((a: string, b: string) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function buildOrganizationState(c: any) {
  const startedAt = performance.now();
  const row = await requireOrganizationProfileRow(c);
  return await buildOrganizationStateFromRow(c, row, startedAt);
}

export async function buildOrganizationStateIfInitialized(c: any) {
  const startedAt = performance.now();
  const row = await readOrganizationProfileRow(c);
  if (!row) {
    return null;
  }
  return await buildOrganizationStateFromRow(c, row, startedAt);
}

async function buildOrganizationStateFromRow(c: any, row: any, startedAt: number) {
  const repoCatalog = await listOrganizationRepoCatalog(c);
  const members = await listOrganizationMembers(c);
  const seatAssignmentEmails = await listOrganizationSeatAssignments(c);
  const invoiceRows = await listOrganizationInvoices(c);

  const state = {
    id: c.state.organizationId,
    organizationId: c.state.organizationId,
    kind: row.kind,
    githubLogin: row.githubLogin,
    githubInstallationId: row.githubInstallationId ?? null,
    stripeCustomerId: row.stripeCustomerId ?? null,
    stripeSubscriptionId: row.stripeSubscriptionId ?? null,
    stripePriceId: row.stripePriceId ?? null,
    billingPlanId: row.billingPlanId,
    snapshot: {
      id: c.state.organizationId,
      organizationId: c.state.organizationId,
      kind: row.kind,
      settings: {
        displayName: row.displayName,
        slug: row.slug,
        primaryDomain: row.primaryDomain,
        seatAccrualMode: "first_prompt",
        autoImportRepos: row.autoImportRepos === 1,
      },
      github: {
        connectedAccount: row.githubConnectedAccount,
        installationStatus: row.githubInstallationStatus,
        syncStatus: row.githubSyncStatus ?? legacyRepoImportStatusToGithubSyncStatus(row.repoImportStatus),
        importedRepoCount: repoCatalog.length,
        lastSyncLabel: row.githubLastSyncLabel,
        lastSyncAt: row.githubLastSyncAt ?? null,
        lastWebhookAt: row.githubLastWebhookAt ?? null,
        lastWebhookEvent: row.githubLastWebhookEvent ?? "",
        syncGeneration: row.githubSyncGeneration ?? 0,
        syncPhase: row.githubSyncPhase ?? null,
        processedRepositoryCount: row.githubProcessedRepositoryCount ?? 0,
        totalRepositoryCount: row.githubTotalRepositoryCount ?? 0,
      },
      billing: {
        planId: row.billingPlanId,
        status: row.billingStatus,
        seatsIncluded: row.billingSeatsIncluded,
        trialEndsAt: row.billingTrialEndsAt,
        renewalAt: row.billingRenewalAt,
        stripeCustomerId: row.stripeCustomerId ?? "",
        paymentMethodLabel: row.billingPaymentMethodLabel,
        invoices: invoiceRows,
      },
      members,
      seatAssignments: seatAssignmentEmails,
      repoCatalog,
    },
  };

  logger.info(
    {
      organizationId: c.state.organizationId,
      githubLogin: row.githubLogin,
      repoCount: repoCatalog.length,
      memberCount: members.length,
      seatAssignmentCount: seatAssignmentEmails.length,
      invoiceCount: invoiceRows.length,
      durationMs: roundDurationMs(startedAt),
    },
    "build_organization_state_completed",
  );

  return state;
}

async function applySubscriptionState(
  organization: any,
  subscription: {
    id: string;
    customerId: string;
    priceId: string | null;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: number | null;
    trialEnd: number | null;
    defaultPaymentMethodLabel: string;
  },
  fallbackPlanId: FoundryBillingPlanId,
): Promise<void> {
  await organization.send(
    organizationWorkflowQueueName("organization.command.billing.stripe_subscription.apply"),
    { subscription, fallbackPlanId },
    { wait: true, timeout: 10_000 },
  );
}

export const organizationAppActions = {
  async createAppCheckoutSession(c: any, input: { sessionId: string; organizationId: string; planId: FoundryBillingPlanId }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (input.planId === "free") {
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.free_plan.apply"),
        { clearSubscription: false },
        { wait: true, timeout: 10_000 },
      );
      return {
        url: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
      };
    }

    if (!appShell.stripe.isConfigured()) {
      throw new Error("Stripe is not configured");
    }

    let customerId = organizationState.stripeCustomerId;
    if (!customerId) {
      customerId = (
        await appShell.stripe.createCustomer({
          organizationId: input.organizationId,
          displayName: organizationState.snapshot.settings.displayName,
          email: session.currentUserEmail,
        })
      ).id;
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.stripe_customer.apply"),
        { customerId },
        { wait: true, timeout: 10_000 },
      );
      await upsertStripeLookupEntries(c, input.organizationId, customerId, null);
    }

    return {
      url: await appShell.stripe
        .createCheckoutSession({
          organizationId: input.organizationId,
          customerId,
          customerEmail: session.currentUserEmail,
          planId: input.planId,
          successUrl: `${appShell.apiUrl}/v1/billing/checkout/complete?organizationId=${encodeURIComponent(
            input.organizationId,
          )}&session_id={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
        })
        .then((checkout) => checkout.url),
    };
  },

  async finalizeAppCheckoutSession(c: any, input: { sessionId: string; organizationId: string; checkoutSessionId: string }): Promise<{ redirectTo: string }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    const completion = await appShell.stripe.retrieveCheckoutCompletion(input.checkoutSessionId);

    if (completion.customerId) {
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.stripe_customer.apply"),
        { customerId: completion.customerId },
        { wait: true, timeout: 10_000 },
      );
    }
    await upsertStripeLookupEntries(c, input.organizationId, completion.customerId, completion.subscriptionId);

    if (completion.subscriptionId) {
      const subscription = await appShell.stripe.retrieveSubscription(completion.subscriptionId);
      await applySubscriptionState(organizationHandle, subscription, completion.planId ?? organizationState.billingPlanId);
    }

    if (completion.paymentMethodLabel) {
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.payment_method.set"),
        { label: completion.paymentMethodLabel },
        { wait: true, timeout: 10_000 },
      );
    }

    return {
      redirectTo: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
    };
  },

  async createAppBillingPortalSession(c: any, input: { sessionId: string; organizationId: string }): Promise<{ url: string }> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);
    if (!organizationState.stripeCustomerId) {
      throw new Error("Stripe customer is not available for this organization");
    }
    const portal = await appShell.stripe.createPortalSession({
      customerId: organizationState.stripeCustomerId,
      returnUrl: `${appShell.appUrl}/organizations/${input.organizationId}/billing`,
    });
    return { url: portal.url };
  },

  async cancelAppScheduledRenewal(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (organizationState.stripeSubscriptionId && appShell.stripe.isConfigured()) {
      const subscription = await appShell.stripe.updateSubscriptionCancellation(organizationState.stripeSubscriptionId, true);
      await applySubscriptionState(organizationHandle, subscription, organizationState.billingPlanId);
      await upsertStripeLookupEntries(c, input.organizationId, subscription.customerId ?? organizationState.stripeCustomerId, subscription.id);
    } else {
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.status.set"),
        { status: "scheduled_cancel" },
        { wait: true, timeout: 10_000 },
      );
    }

    return await buildAppSnapshot(c, input.sessionId);
  },

  async resumeAppSubscription(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const { appShell } = getActorRuntimeContext();
    const organizationHandle = await getOrCreateOrganization(c, input.organizationId);
    const organizationState = await getOrganizationState(organizationHandle);

    if (organizationState.stripeSubscriptionId && appShell.stripe.isConfigured()) {
      const subscription = await appShell.stripe.updateSubscriptionCancellation(organizationState.stripeSubscriptionId, false);
      await applySubscriptionState(organizationHandle, subscription, organizationState.billingPlanId);
      await upsertStripeLookupEntries(c, input.organizationId, subscription.customerId ?? organizationState.stripeCustomerId, subscription.id);
    } else {
      await organizationHandle.send(
        organizationWorkflowQueueName("organization.command.billing.status.set"),
        { status: "active" },
        { wait: true, timeout: 10_000 },
      );
    }

    return await buildAppSnapshot(c, input.sessionId);
  },

  async recordAppSeatUsage(c: any, input: { sessionId: string; organizationId: string }): Promise<FoundryAppSnapshot> {
    assertAppOrganization(c);
    const session = await requireSignedInSession(c, input.sessionId);
    requireEligibleOrganization(session, input.organizationId);
    const organization = await getOrCreateOrganization(c, input.organizationId);
    await organization.send(
      organizationWorkflowQueueName("organization.command.billing.seat_usage.record"),
      { email: session.currentUserEmail },
      { wait: true, timeout: 10_000 },
    );
    return await buildAppSnapshot(c, input.sessionId);
  },

  async handleAppStripeWebhook(c: any, input: { payload: string; signatureHeader: string | null }): Promise<{ ok: true }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const event = appShell.stripe.verifyWebhookEvent(input.payload, input.signatureHeader);

    if (event.type === "checkout.session.completed") {
      const object = event.data.object as Record<string, unknown>;
      const organizationId =
        stringFromMetadata(object.metadata, "organizationId") ??
        (await findOrganizationIdForStripeEvent(
          c,
          typeof object.customer === "string" ? object.customer : null,
          typeof object.subscription === "string" ? object.subscription : null,
        ));
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        if (typeof object.customer === "string") {
          await organization.send(
            organizationWorkflowQueueName("organization.command.billing.stripe_customer.apply"),
            { customerId: object.customer },
            { wait: true, timeout: 10_000 },
          );
        }
        await upsertStripeLookupEntries(
          c,
          organizationId,
          typeof object.customer === "string" ? object.customer : null,
          typeof object.subscription === "string" ? object.subscription : null,
        );
      }
      return { ok: true };
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const subscription = stripeWebhookSubscription(event);
      const organizationId = await findOrganizationIdForStripeEvent(c, subscription.customerId, subscription.id);
      if (organizationId) {
        const organizationHandle = await getOrCreateOrganization(c, organizationId);
        const organizationState = await getOrganizationState(organizationHandle);
        await applySubscriptionState(
          organizationHandle,
          subscription,
          appShell.stripe.planIdForPriceId(subscription.priceId ?? "") ?? organizationState.billingPlanId,
        );
        await upsertStripeLookupEntries(c, organizationId, subscription.customerId, subscription.id);
      }
      return { ok: true };
    }

    if (event.type === "customer.subscription.deleted") {
      const subscription = stripeWebhookSubscription(event);
      const organizationId = await findOrganizationIdForStripeEvent(c, subscription.customerId, subscription.id);
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        await organization.send(
          organizationWorkflowQueueName("organization.command.billing.free_plan.apply"),
          { clearSubscription: true },
          { wait: true, timeout: 10_000 },
        );
      }
      return { ok: true };
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Record<string, unknown>;
      const organizationId = await findOrganizationIdForStripeEvent(c, typeof invoice.customer === "string" ? invoice.customer : null, null);
      if (organizationId) {
        const organization = await getOrCreateOrganization(c, organizationId);
        const rawAmount = typeof invoice.amount_paid === "number" ? invoice.amount_paid : invoice.amount_due;
        const amountUsd = Math.round((typeof rawAmount === "number" ? rawAmount : 0) / 100);
        await organization.send(
          organizationWorkflowQueueName("organization.command.billing.invoice.upsert"),
          {
            id: String(invoice.id),
            label: typeof invoice.number === "string" ? `Invoice ${invoice.number}` : "Stripe invoice",
            issuedAt: formatUnixDate(typeof invoice.created === "number" ? invoice.created : Math.floor(Date.now() / 1000)),
            amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
            status: event.type === "invoice.paid" ? "paid" : "open",
          },
          { wait: true, timeout: 10_000 },
        );
      }
    }

    return { ok: true };
  },

  async handleAppGithubWebhook(c: any, input: { payload: string; signatureHeader: string | null; eventHeader: string | null }): Promise<{ ok: true }> {
    assertAppOrganization(c);
    const { appShell } = getActorRuntimeContext();
    const { event, body } = appShell.github.verifyWebhookEvent(input.payload, input.signatureHeader, input.eventHeader);

    const accountLogin = body.installation?.account?.login ?? body.repository?.owner?.login ?? body.organization?.login ?? null;
    const accountType = body.installation?.account?.type ?? (body.organization?.login ? "Organization" : null);
    if (!accountLogin) {
      githubWebhookLogger.info(
        {
          event,
          action: body.action ?? null,
          reason: "missing_installation_account",
        },
        "ignored",
      );
      return { ok: true };
    }

    const kind: FoundryOrganization["kind"] = accountType === "User" ? "personal" : "organization";
    const organizationId = organizationOrganizationId(kind, accountLogin);
    const receivedAt = Date.now();
    const organization = await getOrCreateOrganization(c, organizationId);
    await organization.send(
      organizationWorkflowQueueName("organization.command.github.webhook_receipt.record"),
      { organizationId, event, action: body.action ?? null, receivedAt },
      { wait: false },
    );
    const githubData = await getOrCreateGithubData(c, organizationId);

    if (event === "installation" && (body.action === "created" || body.action === "deleted" || body.action === "suspend" || body.action === "unsuspend")) {
      githubWebhookLogger.info(
        {
          event,
          action: body.action,
          accountLogin,
          organizationId,
        },
        "installation_event",
      );
      if (body.action === "deleted") {
        await githubData.send(
          githubDataWorkflowQueueName("githubData.command.clearState"),
          { connectedAccount: accountLogin, installationStatus: "install_required", installationId: null, label: "GitHub App installation removed" },
          { wait: false },
        );
      } else if (body.action === "created") {
        void githubData
          .send(
            githubDataWorkflowQueueName("githubData.command.syncRepos"),
            {
              connectedAccount: accountLogin,
              installationStatus: "connected",
              installationId: body.installation?.id ?? null,
              githubLogin: accountLogin,
              kind,
              label: "Syncing GitHub data from installation webhook...",
            },
            { wait: false },
          )
          .catch(() => {});
      } else if (body.action === "suspend") {
        await githubData.send(
          githubDataWorkflowQueueName("githubData.command.clearState"),
          {
            connectedAccount: accountLogin,
            installationStatus: "reconnect_required",
            installationId: body.installation?.id ?? null,
            label: "GitHub App installation suspended",
          },
          { wait: false },
        );
      } else if (body.action === "unsuspend") {
        void githubData
          .send(
            githubDataWorkflowQueueName("githubData.command.syncRepos"),
            {
              connectedAccount: accountLogin,
              installationStatus: "connected",
              installationId: body.installation?.id ?? null,
              githubLogin: accountLogin,
              kind,
              label: "Resyncing GitHub data after unsuspend...",
            },
            { wait: false },
          )
          .catch(() => {});
      }
      return { ok: true };
    }

    if (event === "installation_repositories") {
      githubWebhookLogger.info(
        {
          event,
          action: body.action ?? null,
          accountLogin,
          organizationId,
          repositoriesAdded: body.repositories_added?.length ?? 0,
          repositoriesRemoved: body.repositories_removed?.length ?? 0,
        },
        "repository_membership_changed",
      );
      void githubData
        .send(
          githubDataWorkflowQueueName("githubData.command.syncRepos"),
          {
            connectedAccount: accountLogin,
            installationStatus: "connected",
            installationId: body.installation?.id ?? null,
            githubLogin: accountLogin,
            kind,
            label: "Resyncing GitHub data after repository access change...",
          },
          { wait: false },
        )
        .catch(() => {});
      return { ok: true };
    }

    if (
      event === "push" ||
      event === "pull_request" ||
      event === "pull_request_review" ||
      event === "pull_request_review_comment" ||
      event === "check_run" ||
      event === "check_suite" ||
      event === "status" ||
      event === "create" ||
      event === "delete"
    ) {
      const repoFullName = body.repository?.full_name;
      if (repoFullName) {
        githubWebhookLogger.info(
          {
            event,
            action: body.action ?? null,
            accountLogin,
            organizationId,
            repoFullName,
          },
          "repository_event",
        );
        if (event === "pull_request" && body.repository?.clone_url && body.pull_request) {
          await githubData.send(
            githubDataWorkflowQueueName("githubData.command.handlePullRequestWebhook"),
            {
              connectedAccount: accountLogin,
              installationStatus: "connected",
              installationId: body.installation?.id ?? null,
              repository: {
                fullName: body.repository.full_name,
                cloneUrl: body.repository.clone_url,
                private: Boolean(body.repository.private),
              },
              pullRequest: {
                number: body.pull_request.number,
                status: body.pull_request.draft ? "draft" : "ready",
                title: body.pull_request.title ?? "",
                body: body.pull_request.body ?? null,
                state: body.pull_request.state ?? "open",
                url: body.pull_request.html_url ?? `https://github.com/${body.repository.full_name}/pull/${body.pull_request.number}`,
                headRefName: body.pull_request.head?.ref ?? "",
                baseRefName: body.pull_request.base?.ref ?? "",
                authorLogin: body.pull_request.user?.login ?? null,
                isDraft: Boolean(body.pull_request.draft),
                merged: Boolean(body.pull_request.merged),
              },
            },
            { wait: false },
          );
        }
      }
      return { ok: true };
    }

    githubWebhookLogger.info(
      {
        event,
        action: body.action ?? null,
        accountLogin,
        organizationId,
      },
      "unhandled_event",
    );
    return { ok: true };
  },
};

export async function syncOrganizationShellFromGithubMutation(
  c: any,
  input: {
    userId: string;
    userName: string;
    userEmail: string;
    githubUserLogin: string;
    githubAccountId: string;
    githubLogin: string;
    githubAccountType: string;
    kind: FoundryOrganization["kind"];
    displayName: string;
    installationId: number | null;
    appConfigured: boolean;
  },
): Promise<{ organizationId: string }> {
  assertOrganizationShell(c);
  const now = Date.now();
  const existing = await readOrganizationProfileRow(c);
  const slug = existing?.slug ?? slugify(input.githubLogin);
  const organizationId = organizationOrganizationId(input.kind, input.githubLogin);
  if (organizationId !== c.state.organizationId) {
    throw new Error(`Organization actor mismatch: actor=${c.state.organizationId} github=${organizationId}`);
  }

  const installationStatus =
    input.kind === "personal" ? "connected" : input.installationId ? "connected" : input.appConfigured ? "install_required" : "reconnect_required";
  const syncStatus = existing?.githubSyncStatus ?? legacyRepoImportStatusToGithubSyncStatus(existing?.repoImportStatus);
  const lastSyncLabel =
    syncStatus === "synced"
      ? existing.githubLastSyncLabel
      : installationStatus === "connected"
        ? "Waiting for first import"
        : installationStatus === "install_required"
          ? "GitHub App installation required"
          : "GitHub App configuration incomplete";
  const hasStripeBillingState = Boolean(existing?.stripeCustomerId || existing?.stripeSubscriptionId || existing?.stripePriceId);
  const defaultBillingPlanId = input.kind === "personal" || !hasStripeBillingState ? "free" : (existing?.billingPlanId ?? "team");
  const defaultSeatsIncluded = input.kind === "personal" || !hasStripeBillingState ? 1 : (existing?.billingSeatsIncluded ?? 5);
  const defaultPaymentMethodLabel =
    input.kind === "personal"
      ? "No card required"
      : hasStripeBillingState
        ? (existing?.billingPaymentMethodLabel ?? "Payment method on file")
        : "No payment method on file";

  await c.db
    .insert(organizationProfile)
    .values({
      id: PROFILE_ROW_ID,
      kind: input.kind,
      githubAccountId: input.githubAccountId,
      githubLogin: input.githubLogin,
      githubAccountType: input.githubAccountType,
      displayName: input.displayName,
      slug,
      defaultModel: existing?.defaultModel ?? DEFAULT_WORKSPACE_MODEL_ID,
      primaryDomain: existing?.primaryDomain ?? (input.kind === "personal" ? "personal" : `${slug}.github`),
      autoImportRepos: existing?.autoImportRepos ?? 1,
      repoImportStatus: existing?.repoImportStatus ?? "not_started",
      githubConnectedAccount: input.githubLogin,
      githubInstallationStatus: installationStatus,
      githubSyncStatus: syncStatus,
      githubInstallationId: input.installationId,
      githubLastSyncLabel: lastSyncLabel,
      githubLastSyncAt: existing?.githubLastSyncAt ?? null,
      githubSyncGeneration: existing?.githubSyncGeneration ?? 0,
      githubSyncPhase: existing?.githubSyncPhase ?? null,
      githubProcessedRepositoryCount: existing?.githubProcessedRepositoryCount ?? 0,
      githubTotalRepositoryCount: existing?.githubTotalRepositoryCount ?? 0,
      stripeCustomerId: existing?.stripeCustomerId ?? null,
      stripeSubscriptionId: existing?.stripeSubscriptionId ?? null,
      stripePriceId: existing?.stripePriceId ?? null,
      billingPlanId: defaultBillingPlanId,
      billingStatus: existing?.billingStatus ?? "active",
      billingSeatsIncluded: defaultSeatsIncluded,
      billingTrialEndsAt: existing?.billingTrialEndsAt ?? null,
      billingRenewalAt: existing?.billingRenewalAt ?? null,
      billingPaymentMethodLabel: defaultPaymentMethodLabel,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizationProfile.id,
      set: {
        kind: input.kind,
        githubAccountId: input.githubAccountId,
        githubLogin: input.githubLogin,
        githubAccountType: input.githubAccountType,
        displayName: input.displayName,
        githubConnectedAccount: input.githubLogin,
        githubInstallationStatus: installationStatus,
        githubSyncStatus: syncStatus,
        githubInstallationId: input.installationId,
        githubLastSyncLabel: lastSyncLabel,
        githubLastSyncAt: existing?.githubLastSyncAt ?? null,
        githubSyncGeneration: existing?.githubSyncGeneration ?? 0,
        githubSyncPhase: existing?.githubSyncPhase ?? null,
        githubProcessedRepositoryCount: existing?.githubProcessedRepositoryCount ?? 0,
        githubTotalRepositoryCount: existing?.githubTotalRepositoryCount ?? 0,
        billingPlanId: defaultBillingPlanId,
        billingSeatsIncluded: defaultSeatsIncluded,
        billingPaymentMethodLabel: defaultPaymentMethodLabel,
        updatedAt: now,
      },
    })
    .run();

  await c.db
    .insert(organizationMembers)
    .values({
      id: input.userId,
      name: input.userName,
      email: input.userEmail,
      role: input.kind === "personal" ? "owner" : "admin",
      state: "active",
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizationMembers.id,
      set: {
        name: input.userName,
        email: input.userEmail,
        role: input.kind === "personal" ? "owner" : "admin",
        state: "active",
        updatedAt: now,
      },
    })
    .run();

  // Auto-trigger github-data sync when the org has a connected installation
  // but hasn't synced yet. This handles the common case where a personal
  // account or an org with an existing GitHub App installation signs in for
  // the first time on a fresh DB — the installation webhook already fired
  // before the org actor existed, so we kick off the sync here instead.
  const needsInitialSync = installationStatus === "connected" && syncStatus === "pending";
  if (needsInitialSync) {
    const githubData = await getOrCreateGithubData(c, organizationId);
    void githubData
      .send(
        githubDataWorkflowQueueName("githubData.command.syncRepos"),
        {
          connectedAccount: input.githubLogin,
          installationStatus: "connected",
          installationId: input.installationId,
          githubLogin: input.githubLogin,
          kind: input.kind,
          label: "Initial repository sync...",
        },
        { wait: false },
      )
      .catch(() => {});
  }

  return { organizationId };
}

export async function updateOrganizationShellProfileMutation(
  c: any,
  input: Pick<UpdateFoundryOrganizationProfileInput, "displayName" | "slug" | "primaryDomain">,
): Promise<void> {
  assertOrganizationShell(c);
  const existing = await requireOrganizationProfileRow(c);
  await c.db
    .update(organizationProfile)
    .set({
      displayName: input.displayName.trim() || existing.displayName,
      slug: input.slug.trim() || existing.slug,
      primaryDomain: input.primaryDomain.trim() || existing.primaryDomain,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function markOrganizationSyncStartedMutation(c: any, input: { label: string }): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .update(organizationProfile)
    .set({
      githubSyncStatus: "syncing",
      githubLastSyncLabel: input.label,
      githubSyncPhase: "discovering_repositories",
      githubProcessedRepositoryCount: 0,
      githubTotalRepositoryCount: 0,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function applyOrganizationStripeCustomerMutation(c: any, input: { customerId: string }): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .update(organizationProfile)
    .set({
      stripeCustomerId: input.customerId,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function applyOrganizationStripeSubscriptionMutation(
  c: any,
  input: {
    subscription: {
      id: string;
      customerId: string;
      priceId: string | null;
      status: string;
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd: number | null;
      trialEnd: number | null;
      defaultPaymentMethodLabel: string;
    };
    fallbackPlanId: FoundryBillingPlanId;
  },
): Promise<void> {
  assertOrganizationShell(c);
  const { appShell } = getActorRuntimeContext();
  const planId = appShell.stripe.planIdForPriceId(input.subscription.priceId ?? "") ?? input.fallbackPlanId;
  await c.db
    .update(organizationProfile)
    .set({
      stripeCustomerId: input.subscription.customerId || null,
      stripeSubscriptionId: input.subscription.id || null,
      stripePriceId: input.subscription.priceId,
      billingPlanId: planId,
      billingStatus: stripeStatusToBillingStatus(input.subscription.status, input.subscription.cancelAtPeriodEnd),
      billingSeatsIncluded: seatsIncludedForPlan(planId),
      billingTrialEndsAt: input.subscription.trialEnd ? new Date(input.subscription.trialEnd * 1000).toISOString() : null,
      billingRenewalAt: input.subscription.currentPeriodEnd ? new Date(input.subscription.currentPeriodEnd * 1000).toISOString() : null,
      billingPaymentMethodLabel: input.subscription.defaultPaymentMethodLabel || "Payment method on file",
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function applyOrganizationFreePlanMutation(c: any, input: { clearSubscription: boolean }): Promise<void> {
  assertOrganizationShell(c);
  const patch: Record<string, unknown> = {
    billingPlanId: "free",
    billingStatus: "active",
    billingSeatsIncluded: 1,
    billingTrialEndsAt: null,
    billingRenewalAt: null,
    billingPaymentMethodLabel: "No card required",
    updatedAt: Date.now(),
  };
  if (input.clearSubscription) {
    patch.stripeSubscriptionId = null;
    patch.stripePriceId = null;
  }
  await c.db.update(organizationProfile).set(patch).where(eq(organizationProfile.id, PROFILE_ROW_ID)).run();
}

export async function setOrganizationBillingPaymentMethodMutation(c: any, input: { label: string }): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .update(organizationProfile)
    .set({
      billingPaymentMethodLabel: input.label,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function setOrganizationBillingStatusMutation(c: any, input: { status: FoundryBillingState["status"] }): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .update(organizationProfile)
    .set({
      billingStatus: input.status,
      updatedAt: Date.now(),
    })
    .where(eq(organizationProfile.id, PROFILE_ROW_ID))
    .run();
}

export async function upsertOrganizationInvoiceMutation(
  c: any,
  input: { id: string; label: string; issuedAt: string; amountUsd: number; status: "paid" | "open" },
): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .insert(invoices)
    .values({
      id: input.id,
      label: input.label,
      issuedAt: input.issuedAt,
      amountUsd: input.amountUsd,
      status: input.status,
      createdAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: invoices.id,
      set: {
        label: input.label,
        issuedAt: input.issuedAt,
        amountUsd: input.amountUsd,
        status: input.status,
      },
    })
    .run();
}

export async function recordOrganizationSeatUsageMutation(c: any, input: { email: string }): Promise<void> {
  assertOrganizationShell(c);
  await c.db
    .insert(seatAssignments)
    .values({
      email: input.email,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
}
