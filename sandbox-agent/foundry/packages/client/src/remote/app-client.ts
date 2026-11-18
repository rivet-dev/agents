import type { FoundryAppSnapshot, FoundryBillingPlanId, UpdateFoundryOrganizationProfileInput, WorkspaceModelId } from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "../backend-client.js";
import type { FoundryAppClient } from "../app-client.js";

export interface RemoteFoundryAppClientOptions {
  backend: BackendClient;
}

class RemoteFoundryAppStore implements FoundryAppClient {
  private readonly backend: BackendClient;
  private snapshot: FoundryAppSnapshot = {
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
  private readonly listeners = new Set<() => void>();
  private refreshPromise: Promise<void> | null = null;
  private unsubscribeApp: (() => void) | null = null;

  constructor(options: RemoteFoundryAppClientOptions) {
    this.backend = options.backend;
  }

  getSnapshot(): FoundryAppSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.unsubscribeApp) {
        this.unsubscribeApp();
        this.unsubscribeApp = null;
      }
    };
  }

  async signInWithGithub(userId?: string): Promise<void> {
    void userId;
    await this.backend.signInWithGithub();
  }

  async signOut(): Promise<void> {
    this.snapshot = await this.backend.signOutApp();
    this.notify();
  }

  async skipStarterRepo(): Promise<void> {
    this.snapshot = await this.backend.skipAppStarterRepo();
    this.notify();
  }

  async starStarterRepo(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.starAppStarterRepo(organizationId);
    this.notify();
  }

  async selectOrganization(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.selectAppOrganization(organizationId);
    this.notify();
  }

  async setDefaultModel(model: WorkspaceModelId): Promise<void> {
    this.snapshot = await this.backend.setAppDefaultModel(model);
    this.notify();
  }

  async updateOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<void> {
    this.snapshot = await this.backend.updateAppOrganizationProfile(input);
    this.notify();
  }

  async triggerGithubSync(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.triggerAppRepoImport(organizationId);
    this.notify();
  }

  async completeHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void> {
    await this.backend.completeAppHostedCheckout(organizationId, planId);
  }

  async openBillingPortal(organizationId: string): Promise<void> {
    await this.backend.openAppBillingPortal(organizationId);
  }

  async cancelScheduledRenewal(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.cancelAppScheduledRenewal(organizationId);
    this.notify();
  }

  async resumeSubscription(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.resumeAppSubscription(organizationId);
    this.notify();
  }

  async reconnectGithub(organizationId: string): Promise<void> {
    await this.backend.reconnectAppGithub(organizationId);
  }

  async recordSeatUsage(organizationId: string): Promise<void> {
    this.snapshot = await this.backend.recordAppSeatUsage(organizationId);
    this.notify();
  }

  private ensureStarted(): void {
    if (!this.unsubscribeApp) {
      this.unsubscribeApp = this.backend.subscribeApp(() => {
        void this.refresh();
      });
    }
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      this.snapshot = await this.backend.getAppSnapshot();
      this.notify();
    })().finally(() => {
      this.refreshPromise = null;
    });

    await this.refreshPromise;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export function createRemoteFoundryAppClient(options: RemoteFoundryAppClientOptions): FoundryAppClient {
  return new RemoteFoundryAppStore(options);
}
