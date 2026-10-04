import {
  GitHubAppClient,
  type GitHubInstallationRecord,
  type GitHubOAuthSession,
  type GitHubOrgIdentity,
  type GitHubRepositoryRecord,
  type GitHubViewerIdentity,
  type GitHubWebhookEvent,
} from "./app-github.js";
import {
  StripeAppClient,
  type StripeCheckoutCompletion,
  type StripeCheckoutSession,
  type StripePortalSession,
  type StripeSubscriptionSnapshot,
  type StripeWebhookEvent,
} from "./app-stripe.js";
import type { FoundryBillingPlanId } from "@sandbox-agent/foundry-shared";

export type AppShellGithubClient = Pick<
  GitHubAppClient,
  | "isAppConfigured"
  | "isWebhookConfigured"
  | "buildAuthorizeUrl"
  | "exchangeCode"
  | "getViewer"
  | "listOrganizations"
  | "listInstallations"
  | "listUserRepositories"
  | "listInstallationRepositories"
  | "buildInstallationUrl"
  | "verifyWebhookEvent"
>;

export type AppShellStripeClient = Pick<
  StripeAppClient,
  | "isConfigured"
  | "createCustomer"
  | "createCheckoutSession"
  | "retrieveCheckoutCompletion"
  | "retrieveSubscription"
  | "createPortalSession"
  | "updateSubscriptionCancellation"
  | "verifyWebhookEvent"
  | "planIdForPriceId"
>;

export interface AppShellServices {
  appUrl: string;
  apiUrl: string;
  github: AppShellGithubClient;
  stripe: AppShellStripeClient;
}

export interface CreateAppShellServicesOptions {
  appUrl?: string;
  apiUrl?: string;
  github?: AppShellGithubClient;
  stripe?: AppShellStripeClient;
}

export function createDefaultAppShellServices(options: CreateAppShellServicesOptions = {}): AppShellServices {
  return {
    appUrl: (options.appUrl ?? process.env.APP_URL ?? "http://localhost:4173").replace(/\/$/, ""),
    apiUrl: (options.apiUrl ?? process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:7741").replace(/\/$/, ""),
    github: options.github ?? new GitHubAppClient(),
    stripe: options.stripe ?? new StripeAppClient(),
  };
}

export type {
  GitHubInstallationRecord,
  GitHubOAuthSession,
  GitHubOrgIdentity,
  GitHubRepositoryRecord,
  GitHubViewerIdentity,
  GitHubWebhookEvent,
  StripeCheckoutCompletion,
  StripeCheckoutSession,
  StripePortalSession,
  StripeSubscriptionSnapshot,
  StripeWebhookEvent,
  FoundryBillingPlanId,
};
