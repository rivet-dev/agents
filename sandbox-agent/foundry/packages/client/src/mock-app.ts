import { DEFAULT_WORKSPACE_MODEL_GROUPS, DEFAULT_WORKSPACE_MODEL_ID, type WorkspaceModelId } from "@sandbox-agent/foundry-shared";

const claudeModels = DEFAULT_WORKSPACE_MODEL_GROUPS.find((group) => group.agentKind === "Claude")?.models ?? [];
const CLAUDE_SECONDARY_MODEL_ID = claudeModels[1]?.id ?? claudeModels[0]?.id ?? DEFAULT_WORKSPACE_MODEL_ID;
const CLAUDE_TERTIARY_MODEL_ID = claudeModels[2]?.id ?? CLAUDE_SECONDARY_MODEL_ID;
import { injectMockLatency } from "./mock/latency.js";
import rivetDevFixture from "../../../scripts/data/rivet-dev.json" with { type: "json" };

export type MockBillingPlanId = "free" | "team";
export type MockBillingStatus = "active" | "trialing" | "past_due" | "scheduled_cancel";
export type MockGithubInstallationStatus = "connected" | "install_required" | "reconnect_required";
export type MockGithubSyncStatus = "pending" | "syncing" | "synced" | "error";
export type MockOrganizationKind = "personal" | "organization";
export type MockStarterRepoStatus = "pending" | "starred" | "skipped";

export interface MockFoundryUser {
  id: string;
  name: string;
  email: string;
  githubLogin: string;
  roleLabel: string;
  eligibleOrganizationIds: string[];
  defaultModel: WorkspaceModelId;
}

export interface MockFoundryOrganizationMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  state: "active" | "invited";
}

export interface MockFoundryInvoice {
  id: string;
  label: string;
  issuedAt: string;
  amountUsd: number;
  status: "paid" | "open";
}

export interface MockFoundryBillingState {
  planId: MockBillingPlanId;
  status: MockBillingStatus;
  seatsIncluded: number;
  trialEndsAt: string | null;
  renewalAt: string | null;
  stripeCustomerId: string;
  paymentMethodLabel: string;
  invoices: MockFoundryInvoice[];
}

export interface MockFoundryGithubState {
  connectedAccount: string;
  installationStatus: MockGithubInstallationStatus;
  syncStatus: MockGithubSyncStatus;
  importedRepoCount: number;
  lastSyncLabel: string;
  lastSyncAt: number | null;
  lastWebhookAt: number | null;
  lastWebhookEvent: string;
}

export interface MockFoundryOrganizationSettings {
  displayName: string;
  slug: string;
  primaryDomain: string;
  seatAccrualMode: "first_prompt";
  autoImportRepos: boolean;
}

export interface MockFoundryOrganization {
  id: string;
  organizationId: string;
  kind: MockOrganizationKind;
  settings: MockFoundryOrganizationSettings;
  github: MockFoundryGithubState;
  billing: MockFoundryBillingState;
  members: MockFoundryOrganizationMember[];
  seatAssignments: string[];
  repoCatalog: string[];
}

export interface MockFoundryAppSnapshot {
  auth: {
    status: "signed_out" | "signed_in";
    currentUserId: string | null;
  };
  activeOrganizationId: string | null;
  onboarding: {
    starterRepo: {
      repoFullName: string;
      repoUrl: string;
      status: MockStarterRepoStatus;
      starredAt: number | null;
      skippedAt: number | null;
    };
  };
  users: MockFoundryUser[];
  organizations: MockFoundryOrganization[];
}

export interface UpdateMockOrganizationProfileInput {
  organizationId: string;
  displayName: string;
  slug: string;
  primaryDomain: string;
}

export interface MockFoundryAppClient {
  getSnapshot(): MockFoundryAppSnapshot;
  subscribe(listener: () => void): () => void;
  signInWithGithub(userId: string): Promise<void>;
  signOut(): Promise<void>;
  skipStarterRepo(): Promise<void>;
  starStarterRepo(organizationId: string): Promise<void>;
  selectOrganization(organizationId: string): Promise<void>;
  setDefaultModel(model: WorkspaceModelId): Promise<void>;
  updateOrganizationProfile(input: UpdateMockOrganizationProfileInput): Promise<void>;
  triggerGithubSync(organizationId: string): Promise<void>;
  completeHostedCheckout(organizationId: string, planId: MockBillingPlanId): Promise<void>;
  openBillingPortal(organizationId: string): Promise<void>;
  cancelScheduledRenewal(organizationId: string): Promise<void>;
  resumeSubscription(organizationId: string): Promise<void>;
  reconnectGithub(organizationId: string): Promise<void>;
  recordSeatUsage(organizationId: string): void;
}

const STORAGE_KEY = "sandbox-agent-foundry:mock-app:v1";

function isoDate(daysFromNow: number): string {
  const value = new Date();
  value.setDate(value.getDate() + daysFromNow);
  return value.toISOString();
}

function syncStatusFromLegacy(value: unknown): MockGithubSyncStatus {
  switch (value) {
    case "ready":
    case "synced":
      return "synced";
    case "importing":
    case "syncing":
      return "syncing";
    case "error":
      return "error";
    default:
      return "pending";
  }
}

/**
 * Build the "rivet" mock organization from real public GitHub data.
 * Fixture sourced from: scripts/pull-org-data.ts (run against rivet-dev).
 * Members that don't exist in the public fixture get synthetic entries
 * so the mock still has realistic owner/admin/member role distribution.
 */
function buildRivetOrganization(): MockFoundryOrganization {
  const repos = rivetDevFixture.repos.map((r) => r.fullName);
  const fixtureMembers: MockFoundryOrganizationMember[] = rivetDevFixture.members.map((m) => ({
    id: `member-rivet-${m.login.toLowerCase()}`,
    name: m.login,
    email: `${m.login.toLowerCase()}@rivet.dev`,
    role: "member" as const,
    state: "active" as const,
  }));

  // Ensure we have named owner/admin roles for the mock user personas
  // that may not appear in the public members list
  const knownMembers: MockFoundryOrganizationMember[] = [
    { id: "member-rivet-jamie", name: "Jamie", email: "jamie@rivet.dev", role: "owner", state: "active" },
    { id: "member-rivet-nathan", name: "Nathan", email: "nathan@acme.dev", role: "member", state: "active" },
  ];

  // Merge: known members take priority, then fixture members not already covered
  const knownIds = new Set(knownMembers.map((m) => m.id));
  const members = [...knownMembers, ...fixtureMembers.filter((m) => !knownIds.has(m.id))];

  return {
    id: "rivet",
    organizationId: "rivet",
    kind: "organization",
    settings: {
      displayName: rivetDevFixture.name ?? rivetDevFixture.login,
      slug: "rivet",
      primaryDomain: "rivet.dev",
      seatAccrualMode: "first_prompt",
      autoImportRepos: true,
    },
    github: {
      connectedAccount: rivetDevFixture.login,
      installationStatus: "connected",
      syncStatus: "synced",
      importedRepoCount: repos.length,
      lastSyncLabel: "Synced just now",
      lastSyncAt: Date.now() - 60_000,
      lastWebhookAt: Date.now() - 30_000,
      lastWebhookEvent: "push",
    },
    billing: {
      planId: "team",
      status: "trialing",
      seatsIncluded: 5,
      trialEndsAt: isoDate(12),
      renewalAt: isoDate(12),
      stripeCustomerId: "cus_mock_rivet_team",
      paymentMethodLabel: "Visa ending in 4242",
      invoices: [{ id: "inv-rivet-001", label: "Team pilot", issuedAt: "2026-03-04", amountUsd: 0, status: "paid" }],
    },
    members,
    seatAssignments: ["jamie@rivet.dev"],
    repoCatalog: repos,
  };
}

function buildDefaultSnapshot(): MockFoundryAppSnapshot {
  return {
    auth: {
      status: "signed_out",
      currentUserId: null,
    },
    activeOrganizationId: null,
    onboarding: {
      starterRepo: {
        repoFullName: "rivet-dev/sandbox-agent",
        repoUrl: "https://github.com/rivet-dev/sandbox-agent",
        status: "pending",
        starredAt: null,
        skippedAt: null,
      },
    },
    users: [
      {
        id: "user-nathan",
        name: "Nathan",
        email: "nathan@acme.dev",
        githubLogin: "nathan",
        roleLabel: "Founder",
        eligibleOrganizationIds: ["personal-nathan", "acme", "rivet"],
        defaultModel: DEFAULT_WORKSPACE_MODEL_ID,
      },
      {
        id: "user-maya",
        name: "Maya",
        email: "maya@acme.dev",
        githubLogin: "maya",
        roleLabel: "Staff Engineer",
        eligibleOrganizationIds: ["acme"],
        defaultModel: CLAUDE_SECONDARY_MODEL_ID,
      },
      {
        id: "user-jamie",
        name: "Jamie",
        email: "jamie@rivet.dev",
        githubLogin: "jamie",
        roleLabel: "Platform Lead",
        eligibleOrganizationIds: ["personal-jamie", "rivet"],
        defaultModel: CLAUDE_TERTIARY_MODEL_ID,
      },
    ],
    organizations: [
      {
        id: "personal-nathan",
        organizationId: "personal-nathan",
        kind: "personal",
        settings: {
          displayName: "Nathan",
          slug: "nathan",
          primaryDomain: "personal",
          seatAccrualMode: "first_prompt",
          autoImportRepos: true,
        },
        github: {
          connectedAccount: "nathan",
          installationStatus: "connected",
          syncStatus: "synced",
          importedRepoCount: 1,
          lastSyncLabel: "Synced just now",
          lastSyncAt: Date.now() - 60_000,
          lastWebhookAt: Date.now() - 120_000,
          lastWebhookEvent: "pull_request.opened",
        },
        billing: {
          planId: "free",
          status: "active",
          seatsIncluded: 1,
          trialEndsAt: null,
          renewalAt: null,
          stripeCustomerId: "cus_mock_personal_nathan",
          paymentMethodLabel: "No card required",
          invoices: [],
        },
        members: [{ id: "member-nathan", name: "Nathan", email: "nathan@acme.dev", role: "owner", state: "active" }],
        seatAssignments: ["nathan@acme.dev"],
        repoCatalog: ["nathan/personal-site"],
      },
      {
        id: "acme",
        organizationId: "acme",
        kind: "organization",
        settings: {
          displayName: "Acme",
          slug: "acme",
          primaryDomain: "acme.dev",
          seatAccrualMode: "first_prompt",
          autoImportRepos: true,
        },
        github: {
          connectedAccount: "acme",
          installationStatus: "connected",
          syncStatus: "pending",
          importedRepoCount: 3,
          lastSyncLabel: "Waiting for first import",
          lastSyncAt: null,
          lastWebhookAt: null,
          lastWebhookEvent: "",
        },
        billing: {
          planId: "team",
          status: "active",
          seatsIncluded: 5,
          trialEndsAt: null,
          renewalAt: isoDate(18),
          stripeCustomerId: "cus_mock_acme_team",
          paymentMethodLabel: "Visa ending in 4242",
          invoices: [
            { id: "inv-acme-001", label: "March 2026", issuedAt: "2026-03-01", amountUsd: 240, status: "paid" },
            { id: "inv-acme-000", label: "February 2026", issuedAt: "2026-02-01", amountUsd: 240, status: "paid" },
          ],
        },
        members: [
          { id: "member-acme-nathan", name: "Nathan", email: "nathan@acme.dev", role: "owner", state: "active" },
          { id: "member-acme-maya", name: "Maya", email: "maya@acme.dev", role: "admin", state: "active" },
          { id: "member-acme-priya", name: "Priya", email: "priya@acme.dev", role: "member", state: "active" },
          { id: "member-acme-devon", name: "Devon", email: "devon@acme.dev", role: "member", state: "invited" },
        ],
        seatAssignments: ["nathan@acme.dev", "maya@acme.dev"],
        repoCatalog: ["acme/backend", "acme/frontend", "acme/infra"],
      },
      buildRivetOrganization(),
      {
        id: "personal-jamie",
        organizationId: "personal-jamie",
        kind: "personal",
        settings: {
          displayName: "Jamie",
          slug: "jamie",
          primaryDomain: "personal",
          seatAccrualMode: "first_prompt",
          autoImportRepos: true,
        },
        github: {
          connectedAccount: "jamie",
          installationStatus: "connected",
          syncStatus: "synced",
          importedRepoCount: 1,
          lastSyncLabel: "Synced yesterday",
          lastSyncAt: Date.now() - 24 * 60 * 60_000,
          lastWebhookAt: Date.now() - 3_600_000,
          lastWebhookEvent: "check_run.completed",
        },
        billing: {
          planId: "free",
          status: "active",
          seatsIncluded: 1,
          trialEndsAt: null,
          renewalAt: null,
          stripeCustomerId: "cus_mock_personal_jamie",
          paymentMethodLabel: "No card required",
          invoices: [],
        },
        members: [{ id: "member-jamie", name: "Jamie", email: "jamie@rivet.dev", role: "owner", state: "active" }],
        seatAssignments: ["jamie@rivet.dev"],
        repoCatalog: ["jamie/demo-app"],
      },
    ],
  };
}

function parseStoredSnapshot(): MockFoundryAppSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as MockFoundryAppSnapshot & {
      organizations?: Array<MockFoundryOrganization & { repoImportStatus?: string }>;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...parsed,
      onboarding: {
        starterRepo: {
          repoFullName: parsed.onboarding?.starterRepo?.repoFullName ?? "rivet-dev/sandbox-agent",
          repoUrl: parsed.onboarding?.starterRepo?.repoUrl ?? "https://github.com/rivet-dev/sandbox-agent",
          status: parsed.onboarding?.starterRepo?.status ?? "pending",
          starredAt: parsed.onboarding?.starterRepo?.starredAt ?? null,
          skippedAt: parsed.onboarding?.starterRepo?.skippedAt ?? null,
        },
      },
      organizations: (parsed.organizations ?? []).map((organization: MockFoundryOrganization & { repoImportStatus?: string }) => ({
        ...organization,
        github: {
          ...organization.github,
          syncStatus: syncStatusFromLegacy(organization.github?.syncStatus ?? organization.repoImportStatus),
          lastSyncAt: organization.github?.lastSyncAt ?? null,
          lastWebhookAt: organization.github?.lastWebhookAt ?? null,
          lastWebhookEvent: organization.github?.lastWebhookEvent ?? "",
        },
      })),
    };
  } catch {
    return null;
  }
}

function saveSnapshot(snapshot: MockFoundryAppSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function planSeatsIncluded(planId: MockBillingPlanId): number {
  switch (planId) {
    case "free":
      return 1;
    case "team":
      return 5;
  }
}

class MockFoundryAppStore implements MockFoundryAppClient {
  private snapshot = parseStoredSnapshot() ?? buildDefaultSnapshot();
  private listeners = new Set<() => void>();
  private importTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getSnapshot(): MockFoundryAppSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signInWithGithub(userId: string): Promise<void> {
    await this.injectAsyncLatency();
    const user = this.snapshot.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error(`Unknown mock user ${userId}`);
    }

    this.updateSnapshot((current) => {
      const activeOrganizationId = user.eligibleOrganizationIds.length === 1 ? (user.eligibleOrganizationIds[0] ?? null) : null;
      return {
        ...current,
        auth: {
          status: "signed_in",
          currentUserId: userId,
        },
        activeOrganizationId,
      };
    });

    if (user.eligibleOrganizationIds.length === 1) {
      await this.selectOrganization(user.eligibleOrganizationIds[0]!);
    }
  }

  async signOut(): Promise<void> {
    await this.injectAsyncLatency();
    this.updateSnapshot((current) => ({
      ...current,
      auth: {
        status: "signed_out",
        currentUserId: null,
      },
      activeOrganizationId: null,
      onboarding: {
        starterRepo: {
          ...current.onboarding.starterRepo,
          status: "pending",
          starredAt: null,
          skippedAt: null,
        },
      },
    }));
  }

  async skipStarterRepo(): Promise<void> {
    await this.injectAsyncLatency();
    this.updateSnapshot((current) => ({
      ...current,
      onboarding: {
        starterRepo: {
          ...current.onboarding.starterRepo,
          status: "skipped",
          skippedAt: Date.now(),
          starredAt: null,
        },
      },
    }));
  }

  async starStarterRepo(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    this.updateSnapshot((current) => ({
      ...current,
      onboarding: {
        starterRepo: {
          ...current.onboarding.starterRepo,
          status: "starred",
          starredAt: Date.now(),
          skippedAt: null,
        },
      },
    }));
  }

  async selectOrganization(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    const org = this.requireOrganization(organizationId);
    this.updateSnapshot((current) => ({
      ...current,
      activeOrganizationId: organizationId,
    }));

    if (org.github.syncStatus !== "synced") {
      await this.triggerGithubSync(organizationId);
    }
  }

  async setDefaultModel(model: WorkspaceModelId): Promise<void> {
    await this.injectAsyncLatency();
    const currentUserId = this.snapshot.auth.currentUserId;
    if (!currentUserId) {
      throw new Error("No signed-in mock user");
    }
    this.updateSnapshot((current) => ({
      ...current,
      users: current.users.map((user) => (user.id === currentUserId ? { ...user, defaultModel: model } : user)),
    }));
  }

  async updateOrganizationProfile(input: UpdateMockOrganizationProfileInput): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(input.organizationId);
    this.updateOrganization(input.organizationId, (organization) => ({
      ...organization,
      settings: {
        ...organization.settings,
        displayName: input.displayName.trim() || organization.settings.displayName,
        slug: input.slug.trim() || organization.settings.slug,
        primaryDomain: input.primaryDomain.trim() || organization.settings.primaryDomain,
      },
    }));
  }

  async triggerGithubSync(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    const existingTimer = this.importTimers.get(organizationId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    this.updateOrganization(organizationId, (organization) => ({
      ...organization,
      github: {
        ...organization.github,
        syncStatus: "syncing",
        lastSyncLabel: "Syncing repositories...",
      },
    }));

    const timer = setTimeout(() => {
      this.updateOrganization(organizationId, (organization) => ({
        ...organization,
        github: {
          ...organization.github,
          importedRepoCount: organization.repoCatalog.length,
          installationStatus: "connected",
          syncStatus: "synced",
          lastSyncLabel: "Synced just now",
          lastSyncAt: Date.now(),
          lastWebhookAt: Date.now(),
          lastWebhookEvent: "installation_repositories.added",
        },
      }));
      this.importTimers.delete(organizationId);
    }, 1_250);

    this.importTimers.set(organizationId, timer);
  }

  async completeHostedCheckout(organizationId: string, planId: MockBillingPlanId): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    this.updateOrganization(organizationId, (organization) => ({
      ...organization,
      billing: {
        ...organization.billing,
        planId,
        status: "active",
        seatsIncluded: planSeatsIncluded(planId),
        trialEndsAt: null,
        renewalAt: isoDate(30),
        paymentMethodLabel: "Visa ending in 4242",
        invoices: [
          {
            id: `inv-${organizationId}-${Date.now()}`,
            label: `${organization.settings.displayName} ${planId} upgrade`,
            issuedAt: new Date().toISOString().slice(0, 10),
            amountUsd: planId === "team" ? 240 : 0,
            status: "paid",
          },
          ...organization.billing.invoices,
        ],
      },
    }));
  }

  async openBillingPortal(_organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
  }

  async cancelScheduledRenewal(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    this.updateOrganization(organizationId, (organization) => ({
      ...organization,
      billing: {
        ...organization.billing,
        status: "scheduled_cancel",
      },
    }));
  }

  async resumeSubscription(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    this.updateOrganization(organizationId, (organization) => ({
      ...organization,
      billing: {
        ...organization.billing,
        status: "active",
      },
    }));
  }

  async reconnectGithub(organizationId: string): Promise<void> {
    await this.injectAsyncLatency();
    this.requireOrganization(organizationId);
    this.updateOrganization(organizationId, (organization) => ({
      ...organization,
      github: {
        ...organization.github,
        installationStatus: "connected",
        syncStatus: "pending",
        lastSyncLabel: "Reconnected just now",
        lastSyncAt: Date.now(),
      },
    }));
  }

  recordSeatUsage(organizationId: string): void {
    const org = this.snapshot.organizations.find((candidate) => candidate.organizationId === organizationId);
    const currentUser = currentMockUser(this.snapshot);
    if (!org || !currentUser) {
      return;
    }

    if (org.seatAssignments.includes(currentUser.email)) {
      return;
    }

    this.updateOrganization(org.id, (organization) => ({
      ...organization,
      seatAssignments: [...organization.seatAssignments, currentUser.email],
    }));
  }

  private injectAsyncLatency(): Promise<void> {
    return injectMockLatency();
  }

  private updateOrganization(organizationId: string, updater: (organization: MockFoundryOrganization) => MockFoundryOrganization): void {
    this.updateSnapshot((current) => ({
      ...current,
      organizations: current.organizations.map((organization) => (organization.id === organizationId ? updater(organization) : organization)),
    }));
  }

  private updateSnapshot(updater: (current: MockFoundryAppSnapshot) => MockFoundryAppSnapshot): void {
    this.snapshot = updater(this.snapshot);
    saveSnapshot(this.snapshot);
    for (const listener of this.listeners) {
      listener();
    }
  }

  private requireOrganization(organizationId: string): MockFoundryOrganization {
    const organization = this.snapshot.organizations.find((candidate) => candidate.id === organizationId);
    if (!organization) {
      throw new Error(`Unknown mock organization ${organizationId}`);
    }
    return organization;
  }
}

function currentMockUser(snapshot: MockFoundryAppSnapshot): MockFoundryUser | null {
  if (!snapshot.auth.currentUserId) {
    return null;
  }
  return snapshot.users.find((candidate) => candidate.id === snapshot.auth.currentUserId) ?? null;
}

const mockFoundryAppStore = new MockFoundryAppStore();

export function getMockFoundryAppClient(): MockFoundryAppClient {
  return mockFoundryAppStore;
}

export function currentMockFoundryUser(snapshot: MockFoundryAppSnapshot): MockFoundryUser | null {
  return currentMockUser(snapshot);
}

export function currentMockFoundryOrganization(snapshot: MockFoundryAppSnapshot): MockFoundryOrganization | null {
  if (!snapshot.activeOrganizationId) {
    return null;
  }
  return snapshot.organizations.find((candidate) => candidate.id === snapshot.activeOrganizationId) ?? null;
}

export function eligibleMockOrganizations(snapshot: MockFoundryAppSnapshot): MockFoundryOrganization[] {
  const user = currentMockUser(snapshot);
  if (!user) {
    return [];
  }

  const eligible = new Set(user.eligibleOrganizationIds);
  return snapshot.organizations.filter((organization) => eligible.has(organization.id));
}
