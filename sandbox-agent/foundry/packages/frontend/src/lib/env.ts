type FoundryRuntimeConfig = {
  backendEndpoint?: string;
  defaultOrganizationId?: string;
  frontendClientMode?: string;
};

declare global {
  interface Window {
    __FOUNDRY_RUNTIME_CONFIG__?: FoundryRuntimeConfig;
  }
}

function resolveDefaultBackendEndpoint(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/v1/rivet`;
  }
  return "http://127.0.0.1:7741/v1/rivet";
}

type FrontendImportMetaEnv = ImportMetaEnv & {
  FOUNDRY_FRONTEND_CLIENT_MODE?: string;
};

const frontendEnv = import.meta.env as FrontendImportMetaEnv;
const runtimeConfig = typeof window !== "undefined" ? window.__FOUNDRY_RUNTIME_CONFIG__ : undefined;

export const backendEndpoint = runtimeConfig?.backendEndpoint?.trim() || import.meta.env.VITE_HF_BACKEND_ENDPOINT?.trim() || resolveDefaultBackendEndpoint();

export const defaultOrganizationId = runtimeConfig?.defaultOrganizationId?.trim() || import.meta.env.VITE_HF_WORKSPACE?.trim() || "default";

function resolveFrontendClientMode(): "mock" | "remote" {
  const raw = runtimeConfig?.frontendClientMode?.trim().toLowerCase() || frontendEnv.FOUNDRY_FRONTEND_CLIENT_MODE?.trim().toLowerCase();
  if (raw === "mock") {
    return "mock";
  }
  if (raw === "remote" || raw === "" || raw === undefined) {
    return "remote";
  }
  throw new Error(
    `Unsupported FOUNDRY_FRONTEND_CLIENT_MODE value "${runtimeConfig?.frontendClientMode ?? frontendEnv.FOUNDRY_FRONTEND_CLIENT_MODE}". Expected "mock" or "remote".`,
  );
}

export const frontendClientMode = resolveFrontendClientMode();
export const isMockFrontendClient = frontendClientMode === "mock";
