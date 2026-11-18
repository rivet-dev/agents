import { SandboxDestroyedError } from "../client.ts";
import type { SandboxProvider } from "./types.ts";

const DEFAULT_API_URL = process.env.COMPUTER_API_URL ?? process.env.AGENTCOMPUTER_API_URL ?? "https://api.computer.agentcomputer.ai";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_START_TIMEOUT_MS = 300_000;
const DEFAULT_CWD = "/home/node";
const BROWSER_ACCESS_REFRESH_SKEW_MS = 30_000;
const BROWSER_SESSION_COOKIE = "agentcomputer_access_session";

const READY_STATUSES = new Set(["starting", "running"]);
const FAILED_STATUSES = new Set(["deleted", "error", "stopped", "stopping"]);

type MaybePromise<T> = T | Promise<T>;

export interface AgentComputerCreateOverrides {
  handle?: string;
  displayName?: string;
  runtimeFamily?: string;
  sourceKind?: string;
  imageFamily?: string;
  imageRef?: string;
  sourceRepoUrl?: string;
  sourceRef?: string;
  sourceCommitSha?: string;
  sourceSubpath?: string;
  primaryPort?: number;
  primaryPath?: string;
  healthcheckType?: string;
  healthcheckValue?: string;
  sshEnabled?: boolean;
  vncEnabled?: boolean;
  workspaceName?: string;
  usePlatformDefault?: boolean;
  idea?: string;
  initialPrompt?: string;
}

export interface AgentComputerProviderOptions {
  apiKey?: string | (() => MaybePromise<string>);
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  create?: AgentComputerCreateOverrides | (() => MaybePromise<AgentComputerCreateOverrides>);
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  defaultCwd?: string;
}

interface AgentComputerComputer {
  id: string;
  status?: string;
  last_error?: string;
}

interface AgentComputerConnectionResponse {
  connection?: {
    web_url?: string;
  };
}

interface AgentComputerBrowserAccessResponse {
  access_url?: string;
  expires_at?: string;
}

interface BrowserAccessState {
  accessToken: string;
  inspectorUrl: string;
  expiresAt: number;
}

class AgentComputerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AgentComputerApiError";
    this.status = status;
  }
}

async function resolveApiKey(value: AgentComputerProviderOptions["apiKey"]): Promise<string> {
  const raw = typeof value === "function" ? await value() : (value ?? process.env.COMPUTER_API_KEY ?? process.env.AGENTCOMPUTER_API_KEY ?? "");
  const apiKey = raw.trim();
  if (!apiKey) {
    throw new Error("agentcomputer provider requires an API key. Set COMPUTER_API_KEY (or AGENTCOMPUTER_API_KEY) or pass `apiKey`.");
  }
  return apiKey;
}

async function resolveCreateOptions(value: AgentComputerProviderOptions["create"]): Promise<AgentComputerCreateOverrides> {
  if (!value) {
    return {};
  }
  return typeof value === "function" ? await value() : value;
}

function resolveFetch(fetcher: AgentComputerProviderOptions["fetch"]): typeof globalThis.fetch {
  const resolved = fetcher ?? globalThis.fetch?.bind(globalThis);
  if (!resolved) {
    throw new Error("Fetch API is not available; provide a fetch implementation.");
  }
  return resolved;
}

function normalizeApiUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function serializeCreateOptions(options: AgentComputerCreateOverrides): Record<string, unknown> {
  return {
    handle: options.handle,
    display_name: options.displayName,
    runtime_family: options.runtimeFamily,
    source_kind: options.sourceKind,
    image_family: options.imageFamily,
    image_ref: options.imageRef,
    source_repo_url: options.sourceRepoUrl,
    source_ref: options.sourceRef,
    source_commit_sha: options.sourceCommitSha,
    source_subpath: options.sourceSubpath,
    primary_port: options.primaryPort,
    primary_path: options.primaryPath,
    healthcheck_type: options.healthcheckType,
    healthcheck_value: options.healthcheckValue,
    ssh_enabled: options.sshEnabled,
    vnc_enabled: options.vncEnabled,
    workspace_name: options.workspaceName,
    use_platform_default: options.usePlatformDefault,
    idea: options.idea,
    initial_prompt: options.initialPrompt,
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        return payload.error;
      }
      return JSON.stringify(payload);
    } catch {
      return response.statusText || "request failed";
    }
  }

  const body = await response.text();
  return body || response.statusText || "request failed";
}

function isNotFoundError(error: unknown): error is AgentComputerApiError {
  return error instanceof AgentComputerApiError && error.status === 404;
}

function isFailedStatus(status: string | undefined): boolean {
  return !!status && FAILED_STATUSES.has(status);
}

function isReadyStatus(status: string | undefined): boolean {
  return !!status && READY_STATUSES.has(status);
}

function formatComputerStatusError(sandboxId: string, computer: AgentComputerComputer): Error {
  const status = computer.status ?? "unknown";
  if (status === "deleted") {
    return new SandboxDestroyedError(sandboxId, "agentcomputer");
  }
  const suffix = computer.last_error ? `: ${computer.last_error}` : "";
  return new Error(`agentcomputer computer '${sandboxId}' is not available (status '${status}'${suffix}).`);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function mergeCookieHeader(existingCookie: string | null, name: string, value: string): string {
  if (!existingCookie?.trim()) {
    return `${name}=${value}`;
  }
  return `${existingCookie}; ${name}=${value}`;
}

function isAuthRedirect(response: Response): boolean {
  if (response.status < 300 || response.status >= 400) {
    return false;
  }
  const location = response.headers.get("location") ?? "";
  return location.includes("/login") || location.includes("auth_required") || location.includes("machine_unauthorized");
}

function parseBrowserAccess(accessUrl: string, expiresAtRaw: string | undefined): BrowserAccessState {
  const url = new URL(accessUrl);
  const accessToken = url.searchParams.get("access_token") ?? url.searchParams.get("token") ?? "";
  if (!accessToken) {
    throw new Error("agentcomputer browser access response did not include an access token.");
  }

  const inspectorUrl = new URL(accessUrl);
  inspectorUrl.pathname = "/ui/";

  const expiresAt = Date.parse(expiresAtRaw ?? "");
  return {
    accessToken,
    inspectorUrl: inspectorUrl.toString(),
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

function shouldRefreshBrowserAccess(state: BrowserAccessState | undefined): boolean {
  if (!state) {
    return true;
  }
  return state.expiresAt <= Date.now() + BROWSER_ACCESS_REFRESH_SKEW_MS;
}

export function agentcomputer(options: AgentComputerProviderOptions = {}): SandboxProvider {
  const apiUrl = normalizeApiUrl(options.apiUrl ?? DEFAULT_API_URL);
  const fetcher = resolveFetch(options.fetch);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const defaultCwd = options.defaultCwd ?? DEFAULT_CWD;
  const connectionUrlBySandbox = new Map<string, string>();
  const browserAccessBySandbox = new Map<string, BrowserAccessState>();
  const readySandboxes = new Set<string>();

  async function apiRequest<T>(path: string, init?: RequestInit, allowNotFound = false): Promise<T | undefined> {
    const headers = new Headers(init?.headers);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
    if (init?.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("authorization", `Bearer ${await resolveApiKey(options.apiKey)}`);

    const response = await fetcher(`${apiUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      if (allowNotFound && response.status === 404) {
        return undefined;
      }
      throw new AgentComputerApiError(response.status, await readErrorMessage(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  async function getComputer(sandboxId: string, allowNotFound = false): Promise<AgentComputerComputer | undefined> {
    return await apiRequest<AgentComputerComputer>(`/v1/computers/${encodeURIComponent(sandboxId)}`, undefined, allowNotFound);
  }

  async function waitUntilBrowserReady(sandboxId: string): Promise<AgentComputerComputer> {
    if (readySandboxes.has(sandboxId)) {
      return { id: sandboxId, status: "running" };
    }

    const startedAt = Date.now();

    while (true) {
      const computer = await getComputer(sandboxId, true);
      if (!computer) {
        throw new SandboxDestroyedError(sandboxId, "agentcomputer");
      }
      if (isReadyStatus(computer.status)) {
        readySandboxes.add(sandboxId);
        return computer;
      }
      if (isFailedStatus(computer.status)) {
        readySandboxes.delete(sandboxId);
        throw formatComputerStatusError(sandboxId, computer);
      }
      if (Date.now() - startedAt >= startTimeoutMs) {
        throw new Error(`agentcomputer computer '${sandboxId}' did not become browser-ready within ${startTimeoutMs}ms.`);
      }
      await sleep(pollIntervalMs);
    }
  }

  async function getConnectionUrl(sandboxId: string): Promise<string> {
    const cached = connectionUrlBySandbox.get(sandboxId);
    if (cached) {
      return cached;
    }

    const response = await apiRequest<AgentComputerConnectionResponse>(`/v1/computers/${encodeURIComponent(sandboxId)}/connection`);
    const webUrl = response?.connection?.web_url?.trim();
    if (!webUrl) {
      throw new Error(`agentcomputer connection info did not return a web_url for '${sandboxId}'.`);
    }

    connectionUrlBySandbox.set(sandboxId, webUrl);
    return webUrl;
  }

  async function mintBrowserAccess(sandboxId: string): Promise<BrowserAccessState> {
    await waitUntilBrowserReady(sandboxId);
    const response = await apiRequest<AgentComputerBrowserAccessResponse>(`/v1/computers/${encodeURIComponent(sandboxId)}/access/browser`, {
      method: "POST",
    });
    const accessUrl = response?.access_url?.trim();
    if (!accessUrl) {
      throw new Error(`agentcomputer browser access did not return an access_url for '${sandboxId}'.`);
    }
    const state = parseBrowserAccess(accessUrl, response?.expires_at);
    browserAccessBySandbox.set(sandboxId, state);
    return state;
  }

  async function ensureBrowserAccess(sandboxId: string): Promise<BrowserAccessState> {
    const cached = browserAccessBySandbox.get(sandboxId);
    if (!shouldRefreshBrowserAccess(cached)) {
      return cached!;
    }
    return await mintBrowserAccess(sandboxId);
  }

  return {
    name: "agentcomputer",
    defaultCwd,
    async create(): Promise<string> {
      const createOptions = await resolveCreateOptions(options.create);
      const computer = await apiRequest<AgentComputerComputer>("/v1/computers", {
        method: "POST",
        body: JSON.stringify(
          serializeCreateOptions({
            runtimeFamily: "managed-worker",
            usePlatformDefault: true,
            ...createOptions,
          }),
        ),
      });

      if (!computer?.id) {
        throw new Error("agentcomputer create response did not return a computer id.");
      }

      await waitUntilBrowserReady(computer.id);
      return computer.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      browserAccessBySandbox.delete(sandboxId);
      connectionUrlBySandbox.delete(sandboxId);
      readySandboxes.delete(sandboxId);
      await apiRequest<void>(`/v1/computers/${encodeURIComponent(sandboxId)}`, { method: "DELETE" }, true);
    },
    async reconnect(sandboxId: string): Promise<void> {
      try {
        const computer = await getComputer(sandboxId, true);
        if (!computer) {
          throw new SandboxDestroyedError(sandboxId, "agentcomputer");
        }
        if (isReadyStatus(computer.status)) {
          readySandboxes.add(sandboxId);
          return;
        }
        if (isFailedStatus(computer.status)) {
          readySandboxes.delete(sandboxId);
          throw formatComputerStatusError(sandboxId, computer);
        }
      } catch (error) {
        if (isNotFoundError(error)) {
          throw new SandboxDestroyedError(sandboxId, "agentcomputer", { cause: error });
        }
        throw error;
      }
    },
    async getUrl(sandboxId: string): Promise<string> {
      return await getConnectionUrl(sandboxId);
    },
    async getFetch(sandboxId: string): Promise<typeof globalThis.fetch> {
      return async (input, init) => {
        const request = new Request(input, init);
        const sandboxOrigin = new URL(await getConnectionUrl(sandboxId)).origin;
        const requestOrigin = new URL(request.url, sandboxOrigin).origin;
        if (requestOrigin !== sandboxOrigin) {
          return await fetcher(request);
        }

        const browserAccess = await ensureBrowserAccess(sandboxId);
        const headers = new Headers(request.headers);
        headers.set("cookie", mergeCookieHeader(headers.get("cookie"), BROWSER_SESSION_COOKIE, browserAccess.accessToken));

        const response = await fetcher(new Request(request, { headers, redirect: "manual" }));
        if (response.status === 401 || isAuthRedirect(response)) {
          browserAccessBySandbox.delete(sandboxId);
        }
        return response;
      };
    },
    async getInspectorUrl(sandboxId: string): Promise<string> {
      const browserAccess = await ensureBrowserAccess(sandboxId);
      return browserAccess.inspectorUrl;
    },
    async ensureServer(): Promise<void> {
      // Managed-worker images already boot sandbox-agent and expose health on /v1/health.
    },
  };
}
