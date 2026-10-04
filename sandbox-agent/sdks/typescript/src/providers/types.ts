export interface SandboxProvider {
  /** Provider name. Must match the prefix in sandbox IDs (for example "e2b"). */
  name: string;

  /** Provision a new sandbox and return the provider-specific ID. */
  create(): Promise<string>;

  /** Permanently tear down a sandbox. */
  destroy(sandboxId: string): Promise<void>;

  /**
   * Reconnect to an existing sandbox before the SDK attempts health checks.
   * Providers can use this to resume paused sandboxes or surface provider-specific
   * reconnect errors.
   */
  reconnect?(sandboxId: string): Promise<void>;

  /**
   * Gracefully stop or pause a sandbox without permanently deleting it.
   * When omitted, callers should fall back to `destroy()`.
   */
  pause?(sandboxId: string): Promise<void>;

  /**
   * Permanently delete a sandbox. When omitted, callers should fall back to
   * `destroy()`.
   */
  kill?(sandboxId: string): Promise<void>;

  /**
   * Return the sandbox-agent base URL for this sandbox.
   * Providers that cannot expose a URL should implement `getFetch()` instead.
   */
  getUrl?(sandboxId: string): Promise<string>;

  /**
   * Return a fetch implementation that routes requests to the sandbox.
   * Providers that expose a URL can implement `getUrl()` instead.
   */
  getFetch?(sandboxId: string): Promise<typeof globalThis.fetch>;

  /**
   * Return a browser-ready Inspector URL for this sandbox.
   * When omitted, the SDK falls back to `${getUrl()}/ui/`.
   */
  getInspectorUrl?(sandboxId: string, baseUrl?: string): Promise<string>;

  /**
   * Ensure the sandbox-agent server process is running inside the sandbox.
   * Called during health-wait after consecutive failures, and before
   * reconnecting to an existing sandbox. Implementations should be
   * idempotent — if the server is already running, this should be a no-op
   * (e.g. the duplicate process exits on port conflict).
   */
  ensureServer?(sandboxId: string): Promise<void>;

  /**
   * Default working directory for sessions when the caller does not specify
   * one. Remote providers should set this to a path that exists inside the
   * sandbox (e.g. '/home/user'). When omitted, falls back to process.cwd().
   */
  defaultCwd?: string;
}
