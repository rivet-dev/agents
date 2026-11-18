import type { WorkspaceModelId } from "./workspace.js";

export type FoundryBillingPlanId = "free" | "team";
export type FoundryBillingStatus = "active" | "trialing" | "past_due" | "scheduled_cancel";
export type FoundryGithubInstallationStatus = "connected" | "install_required" | "reconnect_required";
export type FoundryGithubSyncStatus = "pending" | "syncing" | "synced" | "error";
export type FoundryGithubSyncPhase = "discovering_repositories" | "syncing_repositories" | "syncing_branches" | "syncing_members" | "syncing_pull_requests";
export type FoundryOrganizationKind = "personal" | "organization";
export type FoundryStarterRepoStatus = "pending" | "starred" | "skipped";

export interface FoundryUser {
  id: string;
  name: string;
  email: string;
  githubLogin: string;
  roleLabel: string;
  eligibleOrganizationIds: string[];
  defaultModel: WorkspaceModelId;
}

export interface FoundryOrganizationMember {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  state: "active" | "invited";
}

export interface FoundryInvoice {
  id: string;
  label: string;
  issuedAt: string;
  amountUsd: number;
  status: "paid" | "open";
}

export interface FoundryBillingState {
  planId: FoundryBillingPlanId;
  status: FoundryBillingStatus;
  seatsIncluded: number;
  trialEndsAt: string | null;
  renewalAt: string | null;
  stripeCustomerId: string;
  paymentMethodLabel: string;
  invoices: FoundryInvoice[];
}

export interface FoundryGithubState {
  connectedAccount: string;
  installationStatus: FoundryGithubInstallationStatus;
  syncStatus: FoundryGithubSyncStatus;
  importedRepoCount: number;
  lastSyncLabel: string;
  lastSyncAt: number | null;
  lastWebhookAt: number | null;
  lastWebhookEvent: string;
  syncGeneration?: number;
  syncPhase?: FoundryGithubSyncPhase | null;
  processedRepositoryCount?: number;
  totalRepositoryCount?: number;
}

export interface FoundryOrganizationSettings {
  displayName: string;
  slug: string;
  primaryDomain: string;
  seatAccrualMode: "first_prompt";
  autoImportRepos: boolean;
}

export interface FoundryOrganization {
  id: string;
  organizationId: string;
  kind: FoundryOrganizationKind;
  settings: FoundryOrganizationSettings;
  github: FoundryGithubState;
  billing: FoundryBillingState;
  members: FoundryOrganizationMember[];
  seatAssignments: string[];
  repoCatalog: string[];
}

export interface FoundryAppSnapshot {
  auth: {
    status: "signed_out" | "signed_in";
    currentUserId: string | null;
  };
  activeOrganizationId: string | null;
  onboarding: {
    starterRepo: {
      repoFullName: string;
      repoUrl: string;
      status: FoundryStarterRepoStatus;
      starredAt: number | null;
      skippedAt: number | null;
    };
  };
  users: FoundryUser[];
  organizations: FoundryOrganization[];
}

export interface UpdateFoundryOrganizationProfileInput {
  organizationId: string;
  displayName: string;
  slug: string;
  primaryDomain: string;
}
