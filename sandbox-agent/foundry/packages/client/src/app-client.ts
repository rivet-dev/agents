import type {
  FoundryAppSnapshot,
  FoundryBillingPlanId,
  FoundryOrganization,
  FoundryUser,
  UpdateFoundryOrganizationProfileInput,
  WorkspaceModelId,
} from "@sandbox-agent/foundry-shared";
import type { BackendClient } from "./backend-client.js";
import { getMockFoundryAppClient } from "./mock-app.js";
import { createRemoteFoundryAppClient } from "./remote/app-client.js";

export interface FoundryAppClient {
  getSnapshot(): FoundryAppSnapshot;
  subscribe(listener: () => void): () => void;
  signInWithGithub(userId?: string): Promise<void>;
  signOut(): Promise<void>;
  skipStarterRepo(): Promise<void>;
  starStarterRepo(organizationId: string): Promise<void>;
  selectOrganization(organizationId: string): Promise<void>;
  setDefaultModel(model: WorkspaceModelId): Promise<void>;
  updateOrganizationProfile(input: UpdateFoundryOrganizationProfileInput): Promise<void>;
  triggerGithubSync(organizationId: string): Promise<void>;
  completeHostedCheckout(organizationId: string, planId: FoundryBillingPlanId): Promise<void>;
  openBillingPortal(organizationId: string): Promise<void>;
  cancelScheduledRenewal(organizationId: string): Promise<void>;
  resumeSubscription(organizationId: string): Promise<void>;
  reconnectGithub(organizationId: string): Promise<void>;
  recordSeatUsage(organizationId: string): Promise<void>;
}

export interface CreateFoundryAppClientOptions {
  mode: "mock" | "remote";
  backend?: BackendClient;
}

export function createFoundryAppClient(options: CreateFoundryAppClientOptions): FoundryAppClient {
  if (options.mode === "mock") {
    return getMockFoundryAppClient() as unknown as FoundryAppClient;
  }
  if (!options.backend) {
    throw new Error("Remote app client requires a backend client");
  }
  return createRemoteFoundryAppClient({ backend: options.backend });
}

export function currentFoundryUser(snapshot: FoundryAppSnapshot): FoundryUser | null {
  if (!snapshot.auth.currentUserId) {
    return null;
  }
  return snapshot.users.find((candidate) => candidate.id === snapshot.auth.currentUserId) ?? null;
}

export function currentFoundryOrganization(snapshot: FoundryAppSnapshot): FoundryOrganization | null {
  if (!snapshot.activeOrganizationId) {
    return null;
  }
  return snapshot.organizations.find((candidate) => candidate.id === snapshot.activeOrganizationId) ?? null;
}

export function eligibleFoundryOrganizations(snapshot: FoundryAppSnapshot): FoundryOrganization[] {
  const user = currentFoundryUser(snapshot);
  if (!user) {
    return [];
  }

  const eligible = new Set(user.eligibleOrganizationIds);
  return snapshot.organizations.filter((organization) => eligible.has(organization.id));
}
