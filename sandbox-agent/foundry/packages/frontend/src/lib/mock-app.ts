import { useSyncExternalStore } from "react";
import {
  createFoundryAppClient,
  useSubscription,
  currentFoundryOrganization,
  currentFoundryUser,
  eligibleFoundryOrganizations,
  type FoundryAppClient,
} from "@sandbox-agent/foundry-client";
import type {
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  FoundryOrganization,
  UpdateFoundryOrganizationProfileInput,
  WorkspaceModelId,
} from "@sandbox-agent/foundry-shared";
import { backendClient } from "./backend";
import { subscriptionManager } from "./subscription";
import { frontendClientMode } from "./env";

const REMOTE_APP_SESSION_STORAGE_KEY = "sandbox-agent-foundry:remote-app-session";

const EMPTY_APP_SNAPSHOT: FoundryAppSnapshot = {
  auth: { status: "signed_out", currentUserId: null },
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
  users: [],
  organizations: [],
};

const legacyAppClient: FoundryAppClient = createFoundryAppClient({
  mode: frontendClientMode,
  backend: frontendClientMode === "remote" ? backendClient : undefined,
});

const remoteAppClient: FoundryAppClient = {
  getSnapshot(): FoundryAppSnapshot {
    return subscriptionManager.getSnapshot("app", {}) ?? EMPTY_APP_SNAPSHOT;
  },
  subscribe(listener: () => void): () => void {
    return subscriptionManager.subscribe("app", {}, listener);
  },
  async signInWithGithub(userId?: string): Promise<void> {
    void userId;
    await backendClient.signInWithGithub();
  },
  async signOut(): Promise<void> {
    window.localStorage.removeItem(REMOTE_APP_SESSION_STORAGE_KEY);
    await backendClient.signOutApp();
  },
  async skipStarterRepo(): Promise<void> {
    await backendClient.skipAppStarterRepo();
  },
  async starStarterRepo(organizationId: string): Promise<void> {
    await backendClient.starAppStarterRepo(organizationId);
  },
  async selectOrganization(organizationId: string): Promise<void> {
    await backendClient.selectAppOrganization(organizationId);
  },
  async setDefaultModel(defaultModel: WorkspaceModelId): Promise<void> {
    await backendClient.setAppDefaultModel(defaultModel);
  },
  async updateOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<void> {
    await backendClient.updateAppOrganizationProfile(input);
  },
  async triggerGithubSync(organizationId: string): Promise<void> {
    await backendClient.triggerAppRepoImport(organizationId);
  },
  async completeHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void> {
    await backendClient.completeAppHostedCheckout(organizationId, planId);
  },
  async openBillingPortal(organizationId: string): Promise<void> {
    await backendClient.openAppBillingPortal(organizationId);
  },
  async cancelScheduledRenewal(organizationId: string): Promise<void> {
    await backendClient.cancelAppScheduledRenewal(organizationId);
  },
  async resumeSubscription(organizationId: string): Promise<void> {
    await backendClient.resumeAppSubscription(organizationId);
  },
  async reconnectGithub(organizationId: string): Promise<void> {
    await backendClient.reconnectAppGithub(organizationId);
  },
  async recordSeatUsage(organizationId: string): Promise<void> {
    await backendClient.recordAppSeatUsage(organizationId);
  },
};

const appClient: FoundryAppClient = frontendClientMode === "remote" ? remoteAppClient : legacyAppClient;

export function useMockAppSnapshot(): FoundryAppSnapshot {
  if (frontendClientMode === "remote") {
    const app = useSubscription(subscriptionManager, "app", {});
    if (app.status !== "loading") {
      firstSnapshotDelivered = true;
      // Persist session sentinel so isAppSnapshotBootstrapping can show a loading
      // screen instead of flashing /signin on the next page load / HMR reload.
      const snapshot = app.data ?? EMPTY_APP_SNAPSHOT;
      if (snapshot.auth.status === "signed_in") {
        window.localStorage.setItem(REMOTE_APP_SESSION_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(REMOTE_APP_SESSION_STORAGE_KEY);
      }
    }
    return app.data ?? EMPTY_APP_SNAPSHOT;
  }

  return useSyncExternalStore(appClient.subscribe.bind(appClient), appClient.getSnapshot.bind(appClient), appClient.getSnapshot.bind(appClient));
}

export function useMockAppClient(): FoundryAppClient {
  return appClient;
}

export const activeMockUser = currentFoundryUser;
export const activeMockOrganization = currentFoundryOrganization;
export const eligibleOrganizations = eligibleFoundryOrganizations;

// Track whether the remote client has delivered its first real snapshot.
// Before the first fetch completes the snapshot is the default empty signed_out state,
// so we show a loading screen.  Once the fetch returns we know the truth.
let firstSnapshotDelivered = false;

// The remote client notifies listeners after refresh(), which sets `firstSnapshotDelivered`.
const origSubscribe = appClient.subscribe.bind(appClient);
appClient.subscribe = (listener: () => void): (() => void) => {
  const wrappedListener = () => {
    firstSnapshotDelivered = true;
    listener();
  };
  return origSubscribe(wrappedListener);
};

export function isAppSnapshotBootstrapping(snapshot: FoundryAppSnapshot): boolean {
  if (frontendClientMode !== "remote" || typeof window === "undefined") {
    return false;
  }

  const hasStoredSession = window.localStorage.getItem(REMOTE_APP_SESSION_STORAGE_KEY)?.trim().length;
  if (!hasStoredSession) {
    return false;
  }

  // If the backend has already responded and we're still signed_out, the session is stale.
  if (firstSnapshotDelivered) {
    return false;
  }

  // Still waiting for the initial fetch — show the loading screen.
  return snapshot.auth.status === "signed_out" && snapshot.users.length === 0 && snapshot.organizations.length === 0;
}

export function getMockOrganizationById(snapshot: FoundryAppSnapshot, organizationId: string): FoundryOrganization | null {
  return snapshot.organizations.find((organization) => organization.id === organizationId) ?? null;
}
