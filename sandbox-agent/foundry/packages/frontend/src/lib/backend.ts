import { createBackendClient } from "@sandbox-agent/foundry-client";
import { backendEndpoint, defaultOrganizationId, frontendClientMode } from "./env";

export const backendClient = createBackendClient({
  endpoint: backendEndpoint,
  defaultOrganizationId,
  mode: frontendClientMode,
  encoding: import.meta.env.DEV ? "json" : undefined,
});
