import type { AppConfig, SandboxProviderId } from "@sandbox-agent/foundry-shared";

function hasE2BApiKey(config: AppConfig): boolean {
  return Boolean(config.sandboxProviders.e2b.apiKey?.trim());
}

function forcedSandboxProviderId(): SandboxProviderId | null {
  const raw = process.env.FOUNDRY_SANDBOX_PROVIDER?.trim() ?? process.env.HF_SANDBOX_PROVIDER?.trim() ?? null;
  if (raw === "local" || raw === "e2b") {
    return raw;
  }
  return null;
}

export function defaultSandboxProviderId(config: AppConfig): SandboxProviderId {
  const forced = forcedSandboxProviderId();
  if (forced === "local") {
    return "local";
  }
  if (forced === "e2b") {
    if (!hasE2BApiKey(config)) {
      throw new Error("FOUNDRY_SANDBOX_PROVIDER=e2b requires E2B_API_KEY to be configured.");
    }
    return "e2b";
  }
  return hasE2BApiKey(config) ? "e2b" : "local";
}

export function availableSandboxProviderIds(config: AppConfig): SandboxProviderId[] {
  return hasE2BApiKey(config) ? ["e2b", "local"] : ["local"];
}

export function resolveSandboxProviderId(config: AppConfig, requested?: SandboxProviderId | null): SandboxProviderId {
  if (requested === "e2b" && !hasE2BApiKey(config)) {
    throw new Error("E2B provider is not configured. Set E2B_API_KEY before selecting the e2b provider.");
  }

  return requested ?? defaultSandboxProviderId(config);
}
