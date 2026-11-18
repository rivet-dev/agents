import { MockSubscriptionManager, RemoteSubscriptionManager } from "@sandbox-agent/foundry-client";
import { backendClient } from "./backend";
import { frontendClientMode } from "./env";

export const subscriptionManager = frontendClientMode === "mock" ? new MockSubscriptionManager() : new RemoteSubscriptionManager(backendClient);
